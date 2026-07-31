// SPDX-License-Identifier: MPL-2.0

using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;

internal static class Program
{
    private const string AdapterProtocol = "dwg-engine-adapter/1";
    private const string InspectionSchema = "dwg-inspection/1";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2)
            {
                throw new ArgumentException(
                    "usage: acadsharp-adapter inspect INPUT [--notification-samples N]"
                );
            }

            ValidateEnvironment(args[0]);
            return args[0] switch
            {
                "inspect" => Inspect(args),
                "convert" => throw new NotSupportedException(
                    "ACadSharp conversion is intentionally unavailable until inspection passes "
                        + "the parser memory hard limit"
                ),
                _ => throw new ArgumentException("unsupported adapter command"),
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(SanitizeFailure(error));
            return 1;
        }
    }

    private static int Inspect(string[] args)
    {
        ValidateInspectArguments(args);
        string input = args[1];
        var inputInfo = new FileInfo(input);
        if (!inputInfo.Exists)
        {
            throw new FileNotFoundException("input is not a readable regular file");
        }

        long started = Stopwatch.GetTimestamp();
        var diagnostics = new SortedDictionary<string, ulong>(StringComparer.Ordinal);
        ulong diagnosticCount = 0;
        void OnNotification(object _, NotificationEventArgs notification)
        {
            diagnosticCount++;
            string kind = notification.NotificationType.ToString().ToLowerInvariant();
            diagnostics.TryGetValue(kind, out ulong count);
            diagnostics[kind] = count + 1;
        }

        CadDocument document = DwgReader.Read(input, OnNotification);
        long parsed = Stopwatch.GetTimestamp();

        var entityTypes = new SortedDictionary<string, ulong>(StringComparer.Ordinal);
        var unknownTypes = new SortedDictionary<string, ulong>(StringComparer.Ordinal);
        var text = new TextMetrics();
        var embeddedText = new TextMetrics();
        var referenceCounts = new Dictionary<ulong, ulong>();
        ulong entities = 0;
        ulong blockReferences = 0;
        ulong embeddedAttributes = 0;

        foreach (BlockRecord block in document.BlockRecords)
        {
            foreach (Entity entity in block.Entities)
            {
                entities++;
                string name = LogicalEntityName(entity);
                Increment(entityTypes, name);

                if (entity is ProxyEntity)
                {
                    Increment(unknownTypes, name);
                }

                switch (entity)
                {
                    case Insert insert:
                        blockReferences++;
                        if (insert.Block is not null)
                        {
                            referenceCounts.TryGetValue(insert.Block.Handle, out ulong count);
                            referenceCounts[insert.Block.Handle] = count + 1;
                        }

                        foreach (AttributeEntity attribute in insert.Attributes)
                        {
                            embeddedAttributes++;
                            embeddedText.Include(attribute.Value);
                        }
                        break;
                    case MText mtext:
                        text.Include(mtext.Value);
                        break;
                    case TextEntity textEntity:
                        text.Include(textEntity.Value);
                        break;
                }
            }
        }

        BlockRecord? largestBlock = null;
        foreach (BlockRecord block in document.BlockRecords)
        {
            if (largestBlock is null || block.Entities.Count > largestBlock.Entities.Count)
            {
                largestBlock = block;
            }
        }

        RegisteredCounts registered = CountRegisteredObjects(document);
        ulong structuralEntities = registered.RawEntities >= entities + embeddedAttributes
            ? registered.RawEntities - entities - embeddedAttributes
            : 0;
        ulong objects = registered.RawObjects >= registered.TableObjects
            ? registered.RawObjects - registered.TableObjects
            : 0;

        long analyzed = Stopwatch.GetTimestamp();
        object? bounds = HeaderBounds(document);
        ulong peakRss = PeakResidentBytes();

        var drawing = new Dictionary<string, object?>
        {
            ["version"] = document.Header.Version.ToString(),
            ["maintenance_version"] = document.Header.MaintenanceVersion,
            ["entities"] = entities,
            ["raw_entities"] = registered.RawEntities,
            ["structural_entities"] = structuralEntities,
            ["embedded_attributes"] = embeddedAttributes,
            ["objects"] = objects,
            ["raw_objects"] = registered.RawObjects,
            ["table_objects"] = registered.TableObjects,
            ["layers"] = document.Layers.Count,
            ["text_styles"] = document.TextStyles.Count,
            ["blocks"] = document.BlockRecords.Count,
            ["block_references"] = blockReferences,
            ["largest_block"] = largestBlock is null
                ? null
                : new Dictionary<string, object>
                {
                    ["name"] = string.Empty,
                    ["entity_handles"] = largestBlock.Entities.Count,
                    ["references"] = referenceCounts.GetValueOrDefault(largestBlock.Handle),
                },
        };

        var report = new Dictionary<string, object?>
        {
            ["schema"] = InspectionSchema,
            ["status"] = "ok",
            ["input"] = new Dictionary<string, object> { ["size_bytes"] = (ulong)inputInfo.Length },
            ["drawing"] = drawing,
            ["performance"] = new Dictionary<string, object>
            {
                ["parse_ms"] = ElapsedMilliseconds(started, parsed),
                ["analysis_ms"] = ElapsedMilliseconds(parsed, analyzed),
                ["total_ms"] = ElapsedMilliseconds(started, analyzed),
                ["peak_rss_bytes"] = peakRss,
            },
            ["entity_types"] = entityTypes,
            ["unknown_entities"] = new Dictionary<string, object>
            {
                ["count"] = unknownTypes.Values.Aggregate(0UL, checked((total, count) => total + count)),
                ["by_name"] = unknownTypes,
            },
            ["text"] = text.ToReport(),
            ["embedded_text"] = embeddedText.ToReport(),
            ["bounds"] = bounds,
            ["diagnostics"] = new Dictionary<string, object>
            {
                ["count"] = diagnosticCount,
                ["by_type"] = diagnostics,
            },
        };

        Console.Out.WriteLine(JsonSerializer.Serialize(report, JsonOptions));
        return 0;
    }

    private static void ValidateEnvironment(string command)
    {
        string? protocol = Environment.GetEnvironmentVariable("DWG_VIEWER_ADAPTER_PROTOCOL");
        if (protocol is not null && protocol != AdapterProtocol)
        {
            throw new InvalidOperationException("unsupported adapter protocol");
        }

        string? phase = Environment.GetEnvironmentVariable("DWG_VIEWER_BENCHMARK_PHASE");
        if (phase is not null && phase != command)
        {
            throw new InvalidOperationException("unsupported benchmark phase");
        }
    }

    private static void ValidateInspectArguments(string[] args)
    {
        for (int index = 2; index < args.Length; index++)
        {
            if (
                args[index] != "--notification-samples"
                || index + 1 >= args.Length
                || !ulong.TryParse(args[++index], out _)
            )
            {
                throw new ArgumentException("unsupported inspect arguments");
            }
        }
    }

    private static string LogicalEntityName(Entity entity)
    {
        return entity.ObjectType switch
        {
            ObjectType.MINSERT => "MINSERT",
            ObjectType.DIMENSION_ORDINATE => "DIMENSION_ORDINATE",
            ObjectType.DIMENSION_LINEAR => "DIMENSION_LINEAR",
            ObjectType.DIMENSION_ALIGNED => "DIMENSION_ALIGNED",
            ObjectType.DIMENSION_ANG_3_Pt => "DIMENSION_ANGULAR_3POINT",
            ObjectType.DIMENSION_ANG_2_Ln => "DIMENSION_ANGULAR_2LINE",
            ObjectType.DIMENSION_RADIUS => "DIMENSION_RADIUS",
            ObjectType.DIMENSION_DIAMETER => "DIMENSION_DIAMETER",
            _ => string.IsNullOrWhiteSpace(entity.ObjectName)
                ? entity.GetType().Name.ToUpperInvariant()
                : entity.ObjectName,
        };
    }

    private static void Increment(SortedDictionary<string, ulong> values, string key)
    {
        values.TryGetValue(key, out ulong count);
        values[key] = count + 1;
    }

    private static RegisteredCounts CountRegisteredObjects(CadDocument document)
    {
        FieldInfo? field = typeof(CadDocument).GetField(
            "_cadObjects",
            BindingFlags.Instance | BindingFlags.NonPublic
        );
        if (field?.GetValue(document) is not IDictionary registered)
        {
            return default;
        }

        ulong rawEntities = 0;
        ulong rawObjects = 0;
        ulong tableObjects = 0;
        foreach (object? value in registered.Values)
        {
            if (value is Entity)
            {
                rawEntities++;
            }
            else if (value is CadObject cadObject)
            {
                rawObjects++;
                if (cadObject is TableEntry || ImplementsTable(cadObject.GetType()))
                {
                    tableObjects++;
                }
            }
        }

        return new RegisteredCounts(rawEntities, rawObjects, tableObjects);
    }

    private static bool ImplementsTable(Type type)
    {
        return type.GetInterfaces().Any(value => value.FullName == "ACadSharp.Tables.Collections.ITable");
    }

    private static object? HeaderBounds(CadDocument document)
    {
        var min = document.Header.ModelSpaceExtMin;
        var max = document.Header.ModelSpaceExtMax;
        double[] minimum = [min.X, min.Y, min.Z];
        double[] maximum = [max.X, max.Y, max.Z];
        if (
            minimum.Concat(maximum).Any(value => !double.IsFinite(value))
            || minimum.Zip(maximum).Any(pair => pair.First > pair.Second)
        )
        {
            return null;
        }

        return new Dictionary<string, object> { ["min"] = minimum, ["max"] = maximum };
    }

    private static ulong ElapsedMilliseconds(long started, long ended)
    {
        return checked((ulong)((ended - started) * 1000 / Stopwatch.Frequency));
    }

    private static ulong PeakResidentBytes()
    {
        if (
            (OperatingSystem.IsMacOS() || OperatingSystem.IsLinux())
            && getrusage(0, out RUsage usage) == 0
            && usage.MaximumResidentSetSize > 0
        )
        {
            ulong value = checked((ulong)usage.MaximumResidentSetSize);
            return OperatingSystem.IsMacOS() ? value : checked(value * 1024);
        }

        long fallback = Process.GetCurrentProcess().PeakWorkingSet64;
        return fallback > 0 ? checked((ulong)fallback) : 0;
    }

    private static string SanitizeFailure(Exception error)
    {
        return error switch
        {
            OutOfMemoryException => "ACadSharp adapter ran out of memory",
            FileNotFoundException => "input is not a readable regular file",
            ArgumentException or InvalidOperationException or NotSupportedException =>
                error.Message.Replace(Environment.NewLine, " ", StringComparison.Ordinal),
            _ => "ACadSharp adapter operation failed",
        };
    }

    private readonly record struct RegisteredCounts(
        ulong RawEntities,
        ulong RawObjects,
        ulong TableObjects
    );

    [StructLayout(LayoutKind.Sequential)]
    private struct TimeValue
    {
        public long Seconds;
        public long Microseconds;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RUsage
    {
        public TimeValue UserTime;
        public TimeValue SystemTime;
        public long MaximumResidentSetSize;
        public long IntegralSharedMemorySize;
        public long IntegralUnsharedDataSize;
        public long IntegralUnsharedStackSize;
        public long PageReclaims;
        public long PageFaults;
        public long Swaps;
        public long BlockInputs;
        public long BlockOutputs;
        public long MessagesSent;
        public long MessagesReceived;
        public long SignalsReceived;
        public long VoluntaryContextSwitches;
        public long InvoluntaryContextSwitches;
    }

    [DllImport("libc", EntryPoint = "getrusage", SetLastError = true)]
    private static extern int getrusage(int who, out RUsage usage);

    private sealed class TextMetrics
    {
        private ulong _entities;
        private ulong _hangulEntities;
        private ulong _hangulCharacters;
        private ulong _questionMarks;
        private ulong _replacementCharacters;
        private ulong _nullCharacters;

        public void Include(string? value)
        {
            value ??= string.Empty;
            _entities++;
            ulong entityHangul = 0;
            foreach (char character in value)
            {
                if (IsHangul(character))
                {
                    entityHangul++;
                }
                else if (character == '?')
                {
                    _questionMarks++;
                }
                else if (character == '\uFFFD')
                {
                    _replacementCharacters++;
                }
                else if (character == '\0')
                {
                    _nullCharacters++;
                }
            }

            if (entityHangul > 0)
            {
                _hangulEntities++;
                _hangulCharacters += entityHangul;
            }
        }

        public Dictionary<string, object> ToReport()
        {
            return new Dictionary<string, object>
            {
                ["entities"] = _entities,
                ["hangul_entities"] = _hangulEntities,
                ["hangul_characters"] = _hangulCharacters,
                ["question_marks"] = _questionMarks,
                ["replacement_characters"] = _replacementCharacters,
                ["null_characters"] = _nullCharacters,
            };
        }

        private static bool IsHangul(char character)
        {
            return character is
                >= '\u1100' and <= '\u11FF'
                or >= '\u3130' and <= '\u318F'
                or >= '\uA960' and <= '\uA97F'
                or >= '\uAC00' and <= '\uD7A3'
                or >= '\uD7B0' and <= '\uD7FF';
        }
    }
}
