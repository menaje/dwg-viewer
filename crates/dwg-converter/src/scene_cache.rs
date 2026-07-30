use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Instant;

use acadrust::entities::EntityType;
use acadrust::types::{Color, Vector3};
use acadrust::{CadDocument, DwgReader};
use anyhow::{Context, Result};
use serde::Serialize;

use crate::{duration_ms, peak_rss_bytes, Bounds3, BoundsAccumulator, InputSummary};

pub const CACHE_MAGIC: [u8; 8] = *b"DWGSCN1\0";
pub const CACHE_VERSION_MAJOR: u16 = 1;
pub const CACHE_VERSION_MINOR: u16 = 1;
pub const HEADER_SIZE: u32 = 64;
pub const DIRECTORY_ENTRY_SIZE: u32 = 40;

const DRAWING_RECORD_SIZE: u32 = 80;
const LAYER_RECORD_SIZE: u32 = 40;
const BLOCK_RECORD_SIZE: u32 = 64;
const LINE_RECORD_SIZE: u32 = 80;
const ARC_RECORD_SIZE: u32 = 112;
const CIRCLE_RECORD_SIZE: u32 = 96;
const INSERT_RECORD_SIZE: u32 = 136;
const POLYLINE_HEADER_RECORD_SIZE: u32 = 112;
const POLYLINE_VERTEX_RECORD_SIZE: u32 = 64;
const ELLIPSE_RECORD_SIZE: u32 = 128;
const SPLINE_HEADER_RECORD_SIZE: u32 = 208;
const SPLINE_SCALAR_RECORD_SIZE: u32 = 8;
const SPLINE_POINT_RECORD_SIZE: u32 = 24;
const STRING_TABLE_HEADER_SIZE: u64 = 16;
const SECTION_FLAG_STRING_TABLE: u32 = 1;
const MAX_CACHE_STRING_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct ConvertOptions {
    pub include_input_name: bool,
}

#[derive(Debug, Serialize)]
pub struct ConversionReport {
    pub schema: &'static str,
    pub status: &'static str,
    pub input: InputSummary,
    pub cache: CacheSummary,
    pub coverage: PrimitiveCounts,
    pub performance: CachePerformance,
    pub diagnostics: usize,
}

#[derive(Debug, Serialize)]
pub struct CacheSummary {
    pub format_major: u16,
    pub format_minor: u16,
    pub size_bytes: u64,
    pub validated: bool,
    pub sections: Vec<SectionSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectionSummary {
    pub kind: &'static str,
    pub records: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct PrimitiveCounts {
    pub total_entities: u64,
    pub serialized_entities: u64,
    pub deferred_entities: u64,
    pub lines: u64,
    pub arcs: u64,
    pub circles: u64,
    pub inserts: u64,
    pub lwpolylines: u64,
    pub polylines_2d: u64,
    pub polylines_3d: u64,
    pub polyline_vertices: u64,
    pub ellipses: u64,
    pub splines: u64,
    pub spline_knots: u64,
    pub spline_weights: u64,
    pub spline_control_points: u64,
    pub spline_fit_points: u64,
}

#[derive(Debug, Serialize)]
pub struct CachePerformance {
    pub parse_ms: u64,
    pub write_ms: u64,
    pub total_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_rss_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CacheValidationReport {
    pub schema: &'static str,
    pub status: &'static str,
    pub format_major: u16,
    pub format_minor: u16,
    pub file_size: u64,
    pub source_size: u64,
    pub source_version: u32,
    pub maintenance_version: u32,
    pub sections: Vec<ValidatedSection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidatedSection {
    pub kind: u32,
    pub name: &'static str,
    pub record_size: u32,
    pub offset: u64,
    pub bytes: u64,
    pub records: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u32)]
enum SectionKind {
    Drawing = 1,
    Layers = 2,
    Blocks = 3,
    Lines = 10,
    Arcs = 11,
    Circles = 12,
    Inserts = 13,
    PolylineHeaders = 14,
    PolylineVertices = 15,
    Ellipses = 16,
    SplineHeaders = 17,
    SplineKnots = 18,
    SplineWeights = 19,
    SplineControlPoints = 20,
    SplineFitPoints = 21,
}

impl SectionKind {
    fn name(self) -> &'static str {
        match self {
            Self::Drawing => "drawing",
            Self::Layers => "layers",
            Self::Blocks => "blocks",
            Self::Lines => "lines",
            Self::Arcs => "arcs",
            Self::Circles => "circles",
            Self::Inserts => "inserts",
            Self::PolylineHeaders => "polyline_headers",
            Self::PolylineVertices => "polyline_vertices",
            Self::Ellipses => "ellipses",
            Self::SplineHeaders => "spline_headers",
            Self::SplineKnots => "spline_knots",
            Self::SplineWeights => "spline_weights",
            Self::SplineControlPoints => "spline_control_points",
            Self::SplineFitPoints => "spline_fit_points",
        }
    }

    fn from_code(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::Drawing),
            2 => Some(Self::Layers),
            3 => Some(Self::Blocks),
            10 => Some(Self::Lines),
            11 => Some(Self::Arcs),
            12 => Some(Self::Circles),
            13 => Some(Self::Inserts),
            14 => Some(Self::PolylineHeaders),
            15 => Some(Self::PolylineVertices),
            16 => Some(Self::Ellipses),
            17 => Some(Self::SplineHeaders),
            18 => Some(Self::SplineKnots),
            19 => Some(Self::SplineWeights),
            20 => Some(Self::SplineControlPoints),
            21 => Some(Self::SplineFitPoints),
            _ => None,
        }
    }

    fn expected_record_size(self) -> u32 {
        match self {
            Self::Drawing => DRAWING_RECORD_SIZE,
            Self::Layers => LAYER_RECORD_SIZE,
            Self::Blocks => BLOCK_RECORD_SIZE,
            Self::Lines => LINE_RECORD_SIZE,
            Self::Arcs => ARC_RECORD_SIZE,
            Self::Circles => CIRCLE_RECORD_SIZE,
            Self::Inserts => INSERT_RECORD_SIZE,
            Self::PolylineHeaders => POLYLINE_HEADER_RECORD_SIZE,
            Self::PolylineVertices => POLYLINE_VERTEX_RECORD_SIZE,
            Self::Ellipses => ELLIPSE_RECORD_SIZE,
            Self::SplineHeaders => SPLINE_HEADER_RECORD_SIZE,
            Self::SplineKnots | Self::SplineWeights => SPLINE_SCALAR_RECORD_SIZE,
            Self::SplineControlPoints | Self::SplineFitPoints => SPLINE_POINT_RECORD_SIZE,
        }
    }

    fn uses_string_table(self) -> bool {
        matches!(self, Self::Layers | Self::Blocks)
    }
}

#[derive(Debug, Clone)]
struct SectionEntry {
    kind: SectionKind,
    record_size: u32,
    offset: u64,
    byte_length: u64,
    record_count: u64,
    flags: u32,
}

#[derive(Debug)]
struct CacheWriteSummary {
    counts: PrimitiveCounts,
    sections: Vec<SectionEntry>,
}

#[derive(Debug, Clone)]
struct RawSectionEntry {
    kind: u32,
    record_size: u32,
    offset: u64,
    byte_length: u64,
    record_count: u64,
    flags: u32,
}

pub fn convert_dwg(
    input: &Path,
    output: &Path,
    options: &ConvertOptions,
) -> Result<ConversionReport> {
    if input == output {
        anyhow::bail!("input and output paths must be different");
    }

    let input_metadata = fs::metadata(input)
        .with_context(|| format!("cannot read input metadata: {}", input.display()))?;
    if !input_metadata.is_file() {
        anyhow::bail!("input is not a file: {}", input.display());
    }

    let started = Instant::now();
    let mut reader = DwgReader::from_file(input)
        .with_context(|| format!("cannot open DWG: {}", input.display()))?;
    let document = reader
        .read()
        .with_context(|| format!("cannot parse DWG: {}", input.display()))?;
    let parse_elapsed = started.elapsed();

    let write_started = Instant::now();
    let output_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .with_context(|| {
            format!(
                "cannot create cache (the destination may already exist): {}",
                output.display()
            )
        })?;
    let mut writer = BufWriter::new(output_file);
    let write_result =
        write_scene_cache(&mut writer, &document, input_metadata.len()).and_then(|summary| {
            writer
                .flush()
                .with_context(|| format!("cannot flush cache: {}", output.display()))?;
            Ok(summary)
        });
    let summary = match write_result {
        Ok(summary) => {
            drop(writer);
            summary
        }
        Err(error) => {
            drop(writer);
            let _ = fs::remove_file(output);
            return Err(error).with_context(|| format!("cannot write cache: {}", output.display()));
        }
    };
    if let Err(error) = validate_scene_cache(output) {
        let _ = fs::remove_file(output);
        return Err(error)
            .with_context(|| format!("generated cache failed validation: {}", output.display()));
    }
    let write_elapsed = write_started.elapsed();
    let output_size = fs::metadata(output)
        .with_context(|| format!("cannot read cache metadata: {}", output.display()))?
        .len();

    Ok(ConversionReport {
        schema: "dwg-scene-cache/1",
        status: "ok",
        input: InputSummary {
            name: options.include_input_name.then(|| {
                input
                    .file_name()
                    .unwrap_or(input.as_os_str())
                    .to_string_lossy()
                    .into_owned()
            }),
            size_bytes: input_metadata.len(),
        },
        cache: CacheSummary {
            format_major: CACHE_VERSION_MAJOR,
            format_minor: CACHE_VERSION_MINOR,
            size_bytes: output_size,
            validated: true,
            sections: summary
                .sections
                .iter()
                .map(|section| SectionSummary {
                    kind: section.kind.name(),
                    records: section.record_count,
                    bytes: section.byte_length,
                })
                .collect(),
        },
        coverage: summary.counts,
        performance: CachePerformance {
            parse_ms: duration_ms(parse_elapsed),
            write_ms: duration_ms(write_elapsed),
            total_ms: duration_ms(started.elapsed()),
            peak_rss_bytes: peak_rss_bytes(),
        },
        diagnostics: document.notifications.len(),
    })
}

pub fn validate_scene_cache(path: &Path) -> Result<CacheValidationReport> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("cannot read cache metadata: {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("cache is not a file: {}", path.display());
    }
    let file =
        File::open(path).with_context(|| format!("cannot open cache: {}", path.display()))?;
    validate_scene_cache_reader(BufReader::new(file), metadata.len())
        .with_context(|| format!("invalid scene cache: {}", path.display()))
}

fn validate_scene_cache_reader<R: Read + Seek>(
    mut reader: R,
    actual_file_size: u64,
) -> Result<CacheValidationReport> {
    let mut header = [0_u8; HEADER_SIZE as usize];
    reader
        .read_exact(&mut header)
        .context("cache is shorter than its header")?;
    if header[0..8] != CACHE_MAGIC {
        anyhow::bail!("invalid cache magic");
    }

    let major = slice_u16(&header, 8);
    let minor = slice_u16(&header, 10);
    if major != CACHE_VERSION_MAJOR || minor > CACHE_VERSION_MINOR {
        anyhow::bail!("unsupported cache version {major}.{minor}");
    }
    if slice_u32(&header, 12) != HEADER_SIZE {
        anyhow::bail!("unexpected cache header size");
    }
    let section_count = slice_u32(&header, 16);
    if section_count == 0 || section_count > 1024 {
        anyhow::bail!("invalid section count: {section_count}");
    }
    if slice_u32(&header, 20) != DIRECTORY_ENTRY_SIZE {
        anyhow::bail!("unexpected directory-entry size");
    }

    let directory_offset = slice_u64(&header, 32);
    let declared_file_size = slice_u64(&header, 40);
    let source_size = slice_u64(&header, 48);
    let source_version = slice_u32(&header, 56);
    let maintenance_version = slice_u32(&header, 60);
    if declared_file_size != actual_file_size {
        anyhow::bail!("file-size mismatch: header={declared_file_size}, actual={actual_file_size}");
    }

    let directory_length = u64::from(section_count)
        .checked_mul(u64::from(DIRECTORY_ENTRY_SIZE))
        .context("section-directory size overflow")?;
    let directory_end = directory_offset
        .checked_add(directory_length)
        .context("section-directory offset overflow")?;
    if directory_offset < u64::from(HEADER_SIZE) || directory_end > actual_file_size {
        anyhow::bail!("section directory is outside the file");
    }

    reader.seek(SeekFrom::Start(directory_offset))?;
    let mut entries = Vec::with_capacity(section_count as usize);
    for _ in 0..section_count {
        let mut bytes = [0_u8; DIRECTORY_ENTRY_SIZE as usize];
        reader.read_exact(&mut bytes)?;
        entries.push(RawSectionEntry {
            kind: slice_u32(&bytes, 0),
            record_size: slice_u32(&bytes, 4),
            offset: slice_u64(&bytes, 8),
            byte_length: slice_u64(&bytes, 16),
            record_count: slice_u64(&bytes, 24),
            flags: slice_u32(&bytes, 32),
        });
    }

    validate_section_ranges(&entries, align_up(directory_end, 8), actual_file_size)?;
    validate_required_sections(&entries, minor)?;
    for entry in &entries {
        validate_section_layout(&mut reader, entry)?;
    }
    validate_cross_section_references(&mut reader, &entries)?;

    Ok(CacheValidationReport {
        schema: "dwg-scene-cache-validation/1",
        status: "ok",
        format_major: major,
        format_minor: minor,
        file_size: actual_file_size,
        source_size,
        source_version,
        maintenance_version,
        sections: entries
            .into_iter()
            .map(|entry| ValidatedSection {
                kind: entry.kind,
                name: SectionKind::from_code(entry.kind)
                    .map(SectionKind::name)
                    .unwrap_or("unknown"),
                record_size: entry.record_size,
                offset: entry.offset,
                bytes: entry.byte_length,
                records: entry.record_count,
            })
            .collect(),
    })
}

fn validate_section_ranges(
    entries: &[RawSectionEntry],
    body_start: u64,
    file_size: u64,
) -> Result<()> {
    let mut ranges = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.offset < body_start || entry.offset % 8 != 0 {
            anyhow::bail!("section {} has an invalid or unaligned offset", entry.kind);
        }
        let end = entry
            .offset
            .checked_add(entry.byte_length)
            .context("section range overflow")?;
        if end > file_size {
            anyhow::bail!("section {} extends beyond the file", entry.kind);
        }
        ranges.push((entry.offset, end, entry.kind));
    }
    ranges.sort_unstable_by_key(|range| range.0);
    for pair in ranges.windows(2) {
        if pair[0].1 > pair[1].0 {
            anyhow::bail!("sections {} and {} overlap", pair[0].2, pair[1].2);
        }
    }
    Ok(())
}

fn validate_required_sections(entries: &[RawSectionEntry], minor_version: u16) -> Result<()> {
    let mut required = vec![
        SectionKind::Drawing,
        SectionKind::Layers,
        SectionKind::Blocks,
        SectionKind::Lines,
        SectionKind::Arcs,
        SectionKind::Circles,
        SectionKind::Inserts,
    ];
    if minor_version >= 1 {
        required.extend([
            SectionKind::PolylineHeaders,
            SectionKind::PolylineVertices,
            SectionKind::Ellipses,
            SectionKind::SplineHeaders,
            SectionKind::SplineKnots,
            SectionKind::SplineWeights,
            SectionKind::SplineControlPoints,
            SectionKind::SplineFitPoints,
        ]);
    }
    for kind in required {
        let count = entries
            .iter()
            .filter(|entry| entry.kind == kind as u32)
            .count();
        if count != 1 {
            anyhow::bail!(
                "required section {} must occur exactly once, found {}",
                kind.name(),
                count
            );
        }
    }
    Ok(())
}

fn validate_section_layout<R: Read + Seek>(reader: &mut R, entry: &RawSectionEntry) -> Result<()> {
    let Some(kind) = SectionKind::from_code(entry.kind) else {
        return Ok(());
    };
    if entry.record_size != kind.expected_record_size() {
        anyhow::bail!("{} has an unexpected record size", kind.name());
    }

    if kind.uses_string_table() {
        if entry.flags & SECTION_FLAG_STRING_TABLE == 0
            || entry.byte_length < STRING_TABLE_HEADER_SIZE
        {
            anyhow::bail!("{} has an invalid string-table header", kind.name());
        }
        reader.seek(SeekFrom::Start(entry.offset))?;
        let mut table_header = [0_u8; STRING_TABLE_HEADER_SIZE as usize];
        reader.read_exact(&mut table_header)?;
        if u64::from(slice_u32(&table_header, 0)) != entry.record_count
            || slice_u32(&table_header, 4) != entry.record_size
        {
            anyhow::bail!("{} string-table metadata does not match", kind.name());
        }
        let string_offset = slice_u64(&table_header, 8);
        let minimum_offset = STRING_TABLE_HEADER_SIZE
            .checked_add(
                entry
                    .record_count
                    .checked_mul(u64::from(entry.record_size))
                    .context("string-table record size overflow")?,
            )
            .context("string-table offset overflow")?;
        if string_offset < minimum_offset || string_offset > entry.byte_length {
            anyhow::bail!("{} has an invalid UTF-8 blob offset", kind.name());
        }
        validate_string_references(reader, entry, kind, string_offset)?;
    } else {
        if entry.flags != 0 {
            anyhow::bail!("{} has unsupported section flags", kind.name());
        }
        let expected = entry
            .record_count
            .checked_mul(u64::from(entry.record_size))
            .context("fixed section size overflow")?;
        if entry.byte_length != expected {
            anyhow::bail!("{} byte length does not match its records", kind.name());
        }
    }
    Ok(())
}

fn validate_string_references<R: Read + Seek>(
    reader: &mut R,
    entry: &RawSectionEntry,
    kind: SectionKind,
    string_offset: u64,
) -> Result<()> {
    for index in 0..entry.record_count {
        let record_offset = entry
            .offset
            .checked_add(STRING_TABLE_HEADER_SIZE)
            .and_then(|value| {
                index
                    .checked_mul(u64::from(entry.record_size))
                    .and_then(|relative| value.checked_add(relative))
            })
            .context("string-table record offset overflow")?;
        reader.seek(SeekFrom::Start(record_offset))?;
        let mut record = [0_u8; BLOCK_RECORD_SIZE as usize];
        reader.read_exact(&mut record[..entry.record_size as usize])?;

        match kind {
            SectionKind::Layers => {
                validate_utf8_reference(
                    reader,
                    entry,
                    string_offset,
                    slice_u32(&record, 8),
                    slice_u32(&record, 12),
                )?;
                validate_utf8_reference(
                    reader,
                    entry,
                    string_offset,
                    slice_u32(&record, 16),
                    slice_u32(&record, 20),
                )?;
            }
            SectionKind::Blocks => {
                validate_utf8_reference(
                    reader,
                    entry,
                    string_offset,
                    slice_u32(&record, 8),
                    slice_u32(&record, 12),
                )?;
            }
            _ => unreachable!("only string-table sections are validated here"),
        }
    }
    Ok(())
}

fn validate_utf8_reference<R: Read + Seek>(
    reader: &mut R,
    entry: &RawSectionEntry,
    string_offset: u64,
    relative_offset: u32,
    byte_length: u32,
) -> Result<()> {
    let length = u64::from(byte_length);
    if length > MAX_CACHE_STRING_BYTES {
        anyhow::bail!("cache string is unreasonably large");
    }
    let start = entry
        .offset
        .checked_add(string_offset)
        .and_then(|value| value.checked_add(u64::from(relative_offset)))
        .context("cache string offset overflow")?;
    let end = start
        .checked_add(length)
        .context("cache string range overflow")?;
    let section_end = entry
        .offset
        .checked_add(entry.byte_length)
        .context("cache section range overflow")?;
    if start < entry.offset + string_offset || end > section_end {
        anyhow::bail!("cache string points outside its UTF-8 blob");
    }

    reader.seek(SeekFrom::Start(start))?;
    let mut bytes = vec![0_u8; usize::try_from(length)?];
    reader.read_exact(&mut bytes)?;
    std::str::from_utf8(&bytes).context("cache string is not valid UTF-8")?;
    Ok(())
}

fn validate_cross_section_references<R: Read + Seek>(
    reader: &mut R,
    entries: &[RawSectionEntry],
) -> Result<()> {
    if let Some(headers) = find_section(entries, SectionKind::PolylineHeaders) {
        let vertices = find_section(entries, SectionKind::PolylineVertices)
            .context("polyline headers exist without a vertex pool")?;
        for index in 0..headers.record_count {
            let mut record = [0_u8; POLYLINE_HEADER_RECORD_SIZE as usize];
            read_record(reader, headers, index, &mut record)?;
            validate_pool_range(
                "polyline vertices",
                slice_u64(&record, 32),
                u64::from(slice_u32(&record, 40)),
                vertices.record_count,
            )?;
        }
    }

    if let Some(headers) = find_section(entries, SectionKind::SplineHeaders) {
        let knots = find_section(entries, SectionKind::SplineKnots)
            .context("spline headers exist without a knot pool")?;
        let controls = find_section(entries, SectionKind::SplineControlPoints)
            .context("spline headers exist without a control-point pool")?;
        let weights = find_section(entries, SectionKind::SplineWeights)
            .context("spline headers exist without a weight pool")?;
        let fits = find_section(entries, SectionKind::SplineFitPoints)
            .context("spline headers exist without a fit-point pool")?;

        for index in 0..headers.record_count {
            let mut record = [0_u8; SPLINE_HEADER_RECORD_SIZE as usize];
            read_record(reader, headers, index, &mut record)?;
            validate_pool_range(
                "spline knots",
                slice_u64(&record, 48),
                slice_u64(&record, 56),
                knots.record_count,
            )?;
            validate_pool_range(
                "spline control points",
                slice_u64(&record, 64),
                slice_u64(&record, 72),
                controls.record_count,
            )?;
            validate_pool_range(
                "spline weights",
                slice_u64(&record, 80),
                slice_u64(&record, 88),
                weights.record_count,
            )?;
            validate_pool_range(
                "spline fit points",
                slice_u64(&record, 96),
                slice_u64(&record, 104),
                fits.record_count,
            )?;
        }
    }
    Ok(())
}

fn find_section(entries: &[RawSectionEntry], kind: SectionKind) -> Option<&RawSectionEntry> {
    entries.iter().find(|entry| entry.kind == kind as u32)
}

fn read_record<R: Read + Seek>(
    reader: &mut R,
    section: &RawSectionEntry,
    index: u64,
    buffer: &mut [u8],
) -> Result<()> {
    let offset = section
        .offset
        .checked_add(
            index
                .checked_mul(u64::from(section.record_size))
                .context("record offset overflow")?,
        )
        .context("record offset overflow")?;
    reader.seek(SeekFrom::Start(offset))?;
    reader.read_exact(buffer)?;
    Ok(())
}

fn validate_pool_range(name: &str, first: u64, count: u64, pool_count: u64) -> Result<()> {
    let end = first
        .checked_add(count)
        .with_context(|| format!("{name} range overflow"))?;
    if end > pool_count {
        anyhow::bail!("{name} reference exceeds its pool");
    }
    Ok(())
}

fn write_scene_cache<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    source_size: u64,
) -> Result<CacheWriteSummary> {
    let counts = PrimitiveCounts::from_document(document);
    let section_count = 15_u32;
    let directory_offset = u64::from(HEADER_SIZE);
    let body_offset = align_up(
        directory_offset + u64::from(section_count) * u64::from(DIRECTORY_ENTRY_SIZE),
        8,
    );
    writer.seek(SeekFrom::Start(body_offset))?;

    let layer_indices: HashMap<String, u32> = document
        .layers
        .iter()
        .enumerate()
        .map(|(index, layer)| -> Result<_> {
            Ok((
                layer.name.to_uppercase(),
                u32::try_from(index).context("too many layers for scene cache")?,
            ))
        })
        .collect::<Result<_>>()?;
    let block_indices: HashMap<String, u32> = document
        .block_records
        .iter()
        .enumerate()
        .map(|(index, block)| -> Result<_> {
            Ok((
                block.name.to_uppercase(),
                u32::try_from(index).context("too many blocks for scene cache")?,
            ))
        })
        .collect::<Result<_>>()?;

    let mut sections = Vec::with_capacity(section_count as usize);
    sections.push(write_drawing_section(writer, document, &counts)?);
    sections.push(write_layer_section(writer, document)?);
    sections.push(write_block_section(writer, document)?);
    sections.push(write_line_section(writer, document, &layer_indices)?);
    sections.push(write_arc_section(writer, document, &layer_indices)?);
    sections.push(write_circle_section(writer, document, &layer_indices)?);
    sections.push(write_insert_section(
        writer,
        document,
        &layer_indices,
        &block_indices,
    )?);
    sections.push(write_polyline_header_section(
        writer,
        document,
        &layer_indices,
    )?);
    sections.push(write_polyline_vertex_section(writer, document)?);
    sections.push(write_ellipse_section(writer, document, &layer_indices)?);
    sections.push(write_spline_header_section(
        writer,
        document,
        &layer_indices,
    )?);
    sections.push(write_spline_knot_section(writer, document)?);
    sections.push(write_spline_weight_section(writer, document)?);
    sections.push(write_spline_control_point_section(writer, document)?);
    sections.push(write_spline_fit_point_section(writer, document)?);

    let file_size = writer.stream_position()?;
    writer.seek(SeekFrom::Start(0))?;
    write_header(
        writer,
        section_count,
        directory_offset,
        file_size,
        source_size,
        document.version.version_code().into(),
        document.maintenance_version.into(),
    )?;
    writer.seek(SeekFrom::Start(directory_offset))?;
    for section in &sections {
        write_directory_entry(writer, section)?;
    }
    writer.seek(SeekFrom::Start(file_size))?;

    Ok(CacheWriteSummary { counts, sections })
}

impl PrimitiveCounts {
    fn from_document(document: &CadDocument) -> Self {
        let mut counts = Self {
            total_entities: document.entity_count() as u64,
            ..Self::default()
        };
        for entity in document.entities() {
            match entity {
                EntityType::Line(_) => counts.lines += 1,
                EntityType::Arc(_) => counts.arcs += 1,
                EntityType::Circle(_) => counts.circles += 1,
                EntityType::Insert(_) => counts.inserts += 1,
                EntityType::LwPolyline(polyline) => {
                    counts.lwpolylines += 1;
                    counts.polyline_vertices += polyline.vertices.len() as u64;
                }
                EntityType::Polyline2D(polyline) => {
                    counts.polylines_2d += 1;
                    counts.polyline_vertices += polyline.vertices.len() as u64;
                }
                EntityType::Polyline(polyline) => {
                    counts.polylines_3d += 1;
                    counts.polyline_vertices += polyline.vertices.len() as u64;
                }
                EntityType::Ellipse(_) => counts.ellipses += 1,
                EntityType::Spline(spline) => {
                    counts.splines += 1;
                    counts.spline_knots += spline.knots.len() as u64;
                    counts.spline_weights += spline.weights.len() as u64;
                    counts.spline_control_points += spline.control_points.len() as u64;
                    counts.spline_fit_points += spline.fit_points.len() as u64;
                }
                _ => {}
            }
        }
        counts.serialized_entities = counts.lines
            + counts.arcs
            + counts.circles
            + counts.inserts
            + counts.lwpolylines
            + counts.polylines_2d
            + counts.polylines_3d
            + counts.ellipses
            + counts.splines;
        counts.deferred_entities = counts
            .total_entities
            .saturating_sub(counts.serialized_entities);
        counts
    }
}

fn write_header<W: Write>(
    writer: &mut W,
    section_count: u32,
    directory_offset: u64,
    file_size: u64,
    source_size: u64,
    source_version: u32,
    maintenance_version: u32,
) -> Result<()> {
    writer.write_all(&CACHE_MAGIC)?;
    write_u16(writer, CACHE_VERSION_MAJOR)?;
    write_u16(writer, CACHE_VERSION_MINOR)?;
    write_u32(writer, HEADER_SIZE)?;
    write_u32(writer, section_count)?;
    write_u32(writer, DIRECTORY_ENTRY_SIZE)?;
    write_u32(writer, 0)?;
    write_u32(writer, 0)?;
    write_u64(writer, directory_offset)?;
    write_u64(writer, file_size)?;
    write_u64(writer, source_size)?;
    write_u32(writer, source_version)?;
    write_u32(writer, maintenance_version)?;
    Ok(())
}

fn write_directory_entry<W: Write>(writer: &mut W, entry: &SectionEntry) -> Result<()> {
    write_u32(writer, entry.kind as u32)?;
    write_u32(writer, entry.record_size)?;
    write_u64(writer, entry.offset)?;
    write_u64(writer, entry.byte_length)?;
    write_u64(writer, entry.record_count)?;
    write_u32(writer, entry.flags)?;
    write_u32(writer, 0)?;
    Ok(())
}

fn write_drawing_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    counts: &PrimitiveCounts,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let bounds = drawing_bounds(document).unwrap_or(Bounds3 {
        min: [0.0; 3],
        max: [0.0; 3],
    });
    write_u32(writer, document.version.version_code().into())?;
    write_u32(writer, document.maintenance_version.into())?;
    write_i32(writer, document.header.insertion_units.into())?;
    write_u32(writer, 0)?;
    write_u64(writer, counts.total_entities)?;
    write_u64(writer, counts.serialized_entities)?;
    for value in bounds.min.into_iter().chain(bounds.max) {
        write_f64(writer, value)?;
    }
    finish_fixed_section(writer, SectionKind::Drawing, DRAWING_RECORD_SIZE, offset, 1)
}

fn write_layer_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    struct LayerRow {
        handle: u64,
        name: (u32, u32),
        linetype: (u32, u32),
        color: u32,
        flags: u32,
        line_weight: i32,
    }

    let offset = aligned_position(writer)?;
    let mut strings = Vec::new();
    let mut rows = Vec::with_capacity(document.layers.len());
    for layer in document.layers.iter() {
        let name = push_string(&mut strings, &layer.name)?;
        let linetype = push_string(&mut strings, &layer.line_type)?;
        let mut flags = 0_u32;
        if layer.flags.off {
            flags |= 1;
        }
        if layer.flags.frozen {
            flags |= 1 << 1;
        }
        if layer.flags.locked {
            flags |= 1 << 2;
        }
        if layer.is_plottable {
            flags |= 1 << 3;
        }
        if layer.flags.xref_dependent {
            flags |= 1 << 4;
        }
        rows.push(LayerRow {
            handle: layer.handle.value(),
            name,
            linetype,
            color: encode_color(layer.color),
            flags,
            line_weight: layer.line_weight.value().into(),
        });
    }

    let string_offset =
        STRING_TABLE_HEADER_SIZE + u64::try_from(rows.len())? * u64::from(LAYER_RECORD_SIZE);
    write_u32(writer, u32::try_from(rows.len())?)?;
    write_u32(writer, LAYER_RECORD_SIZE)?;
    write_u64(writer, string_offset)?;
    for row in rows {
        write_u64(writer, row.handle)?;
        write_u32(writer, row.name.0)?;
        write_u32(writer, row.name.1)?;
        write_u32(writer, row.linetype.0)?;
        write_u32(writer, row.linetype.1)?;
        write_u32(writer, row.color)?;
        write_u32(writer, row.flags)?;
        write_i32(writer, row.line_weight)?;
        write_u32(writer, 0)?;
    }
    writer.write_all(&strings)?;

    finish_variable_section(
        writer,
        SectionKind::Layers,
        LAYER_RECORD_SIZE,
        offset,
        document.layers.len() as u64,
        SECTION_FLAG_STRING_TABLE,
    )
}

fn write_block_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    struct BlockRow {
        handle: u64,
        name: (u32, u32),
        entity_count: u32,
        reference_count: u32,
        flags: u32,
        units: i32,
        base_point: Vector3,
    }

    let offset = aligned_position(writer)?;
    let mut strings = Vec::new();
    let mut rows = Vec::with_capacity(document.block_records.len());
    for block in document.block_records.iter() {
        let name = push_string(&mut strings, &block.name)?;
        let mut flags = 0_u32;
        if block.flags.anonymous {
            flags |= 1;
        }
        if block.flags.has_attributes {
            flags |= 1 << 1;
        }
        if block.flags.is_xref {
            flags |= 1 << 2;
        }
        if block.flags.is_xref_overlay {
            flags |= 1 << 3;
        }
        if block.flags.is_external {
            flags |= 1 << 4;
        }
        if block.explodable {
            flags |= 1 << 5;
        }
        if block.scale_uniformly {
            flags |= 1 << 6;
        }
        rows.push(BlockRow {
            handle: block.handle.value(),
            name,
            entity_count: u32::try_from(block.entity_handles.len())
                .context("block contains too many entities for scene cache")?,
            reference_count: u32::try_from(block.insert_handles.len())
                .context("block contains too many references for scene cache")?,
            flags,
            units: block.units.into(),
            base_point: block.base_point,
        });
    }

    let string_offset =
        STRING_TABLE_HEADER_SIZE + u64::try_from(rows.len())? * u64::from(BLOCK_RECORD_SIZE);
    write_u32(writer, u32::try_from(rows.len())?)?;
    write_u32(writer, BLOCK_RECORD_SIZE)?;
    write_u64(writer, string_offset)?;
    for row in rows {
        write_u64(writer, row.handle)?;
        write_u32(writer, row.name.0)?;
        write_u32(writer, row.name.1)?;
        write_u32(writer, row.entity_count)?;
        write_u32(writer, row.reference_count)?;
        write_u32(writer, row.flags)?;
        write_i32(writer, row.units)?;
        write_vec3(writer, row.base_point)?;
        write_u64(writer, 0)?;
    }
    writer.write_all(&strings)?;

    finish_variable_section(
        writer,
        SectionKind::Blocks,
        BLOCK_RECORD_SIZE,
        offset,
        document.block_records.len() as u64,
        SECTION_FLAG_STRING_TABLE,
    )
}

fn write_line_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        if let EntityType::Line(line) = entity {
            write_common(writer, entity, layer_indices)?;
            write_vec3(writer, line.start)?;
            write_vec3(writer, line.end)?;
            count += 1;
        }
    }
    finish_fixed_section(writer, SectionKind::Lines, LINE_RECORD_SIZE, offset, count)
}

fn write_arc_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        if let EntityType::Arc(arc) = entity {
            write_common(writer, entity, layer_indices)?;
            write_vec3(writer, arc.center)?;
            write_f64(writer, arc.radius)?;
            write_f64(writer, arc.start_angle)?;
            write_f64(writer, arc.end_angle)?;
            write_f64(writer, arc.thickness)?;
            write_vec3(writer, arc.normal)?;
            count += 1;
        }
    }
    finish_fixed_section(writer, SectionKind::Arcs, ARC_RECORD_SIZE, offset, count)
}

fn write_circle_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        if let EntityType::Circle(circle) = entity {
            write_common(writer, entity, layer_indices)?;
            write_vec3(writer, circle.center)?;
            write_f64(writer, circle.radius)?;
            write_f64(writer, circle.thickness)?;
            write_vec3(writer, circle.normal)?;
            count += 1;
        }
    }
    finish_fixed_section(
        writer,
        SectionKind::Circles,
        CIRCLE_RECORD_SIZE,
        offset,
        count,
    )
}

fn write_insert_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
    block_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        if let EntityType::Insert(insert) = entity {
            write_common(writer, entity, layer_indices)?;
            write_u32(
                writer,
                block_indices
                    .get(&insert.block_name.to_uppercase())
                    .copied()
                    .unwrap_or(u32::MAX),
            )?;
            write_u16(writer, insert.column_count)?;
            write_u16(writer, insert.row_count)?;
            write_vec3(writer, insert.insert_point)?;
            write_f64(writer, insert.x_scale())?;
            write_f64(writer, insert.y_scale())?;
            write_f64(writer, insert.z_scale())?;
            write_f64(writer, insert.rotation)?;
            write_vec3(writer, insert.normal)?;
            write_f64(writer, insert.column_spacing)?;
            write_f64(writer, insert.row_spacing)?;
            count += 1;
        }
    }
    finish_fixed_section(
        writer,
        SectionKind::Inserts,
        INSERT_RECORD_SIZE,
        offset,
        count,
    )
}

fn write_polyline_header_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut first_vertex = 0_u64;
    let mut count = 0_u64;

    for entity in document.entities() {
        let data = match entity {
            EntityType::LwPolyline(polyline) => Some(PolylineHeaderData {
                kind: 1,
                flags: u16::from(polyline.is_closed) | if polyline.plinegen { 1 << 7 } else { 0 },
                vertex_count: polyline.vertices.len(),
                elevation: polyline.elevation,
                thickness: polyline.thickness,
                normal: polyline.normal,
                default_start_width: 0.0,
                default_end_width: 0.0,
                constant_width: polyline.constant_width,
            }),
            EntityType::Polyline2D(polyline) => Some(PolylineHeaderData {
                kind: 2,
                flags: polyline.flags.bits(),
                vertex_count: polyline.vertices.len(),
                elevation: polyline.elevation,
                thickness: polyline.thickness,
                normal: polyline.normal,
                default_start_width: polyline.start_width,
                default_end_width: polyline.end_width,
                constant_width: 0.0,
            }),
            EntityType::Polyline(polyline) => Some(PolylineHeaderData {
                kind: 3,
                flags: polyline.flags.bits(),
                vertex_count: polyline.vertices.len(),
                elevation: 0.0,
                thickness: 0.0,
                normal: Vector3::UNIT_Z,
                default_start_width: 0.0,
                default_end_width: 0.0,
                constant_width: 0.0,
            }),
            _ => None,
        };
        let Some(data) = data else {
            continue;
        };

        write_common(writer, entity, layer_indices)?;
        write_u64(writer, first_vertex)?;
        write_u32(
            writer,
            u32::try_from(data.vertex_count)
                .context("polyline contains too many vertices for scene cache")?,
        )?;
        write_u16(writer, data.kind)?;
        write_u16(writer, data.flags)?;
        write_f64(writer, data.elevation)?;
        write_f64(writer, data.thickness)?;
        write_vec3(writer, data.normal)?;
        write_f64(writer, data.default_start_width)?;
        write_f64(writer, data.default_end_width)?;
        write_f64(writer, data.constant_width)?;

        first_vertex = first_vertex
            .checked_add(u64::try_from(data.vertex_count)?)
            .context("polyline vertex index overflow")?;
        count += 1;
    }

    finish_fixed_section(
        writer,
        SectionKind::PolylineHeaders,
        POLYLINE_HEADER_RECORD_SIZE,
        offset,
        count,
    )
}

struct PolylineHeaderData {
    kind: u16,
    flags: u16,
    vertex_count: usize,
    elevation: f64,
    thickness: f64,
    normal: Vector3,
    default_start_width: f64,
    default_end_width: f64,
    constant_width: f64,
}

fn write_polyline_vertex_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;

    for entity in document.entities() {
        match entity {
            EntityType::LwPolyline(polyline) => {
                for vertex in &polyline.vertices {
                    write_polyline_vertex(
                        writer,
                        &PolylineVertexRecord {
                            position: Vector3::new(
                                vertex.location.x,
                                vertex.location.y,
                                polyline.elevation,
                            ),
                            bulge: vertex.bulge,
                            start_width: vertex.start_width,
                            end_width: vertex.end_width,
                            curve_tangent: 0.0,
                            flags: 0,
                            id: 0,
                        },
                    )?;
                    count += 1;
                }
            }
            EntityType::Polyline2D(polyline) => {
                for vertex in &polyline.vertices {
                    write_polyline_vertex(
                        writer,
                        &PolylineVertexRecord {
                            position: vertex.location,
                            bulge: vertex.bulge,
                            start_width: vertex.start_width,
                            end_width: vertex.end_width,
                            curve_tangent: vertex.curve_tangent,
                            flags: u32::from(vertex.flags.bits()),
                            id: vertex.id,
                        },
                    )?;
                    count += 1;
                }
            }
            EntityType::Polyline(polyline) => {
                for vertex in &polyline.vertices {
                    write_polyline_vertex(
                        writer,
                        &PolylineVertexRecord {
                            position: vertex.location,
                            bulge: 0.0,
                            start_width: 0.0,
                            end_width: 0.0,
                            curve_tangent: 0.0,
                            flags: u32::from(vertex.flags.bits()),
                            id: 0,
                        },
                    )?;
                    count += 1;
                }
            }
            _ => {}
        }
    }

    finish_fixed_section(
        writer,
        SectionKind::PolylineVertices,
        POLYLINE_VERTEX_RECORD_SIZE,
        offset,
        count,
    )
}

struct PolylineVertexRecord {
    position: Vector3,
    bulge: f64,
    start_width: f64,
    end_width: f64,
    curve_tangent: f64,
    flags: u32,
    id: i32,
}

fn write_polyline_vertex<W: Write>(writer: &mut W, vertex: &PolylineVertexRecord) -> Result<()> {
    write_vec3(writer, vertex.position)?;
    write_f64(writer, vertex.bulge)?;
    write_f64(writer, vertex.start_width)?;
    write_f64(writer, vertex.end_width)?;
    write_f64(writer, vertex.curve_tangent)?;
    write_u32(writer, vertex.flags)?;
    write_i32(writer, vertex.id)?;
    Ok(())
}

fn write_ellipse_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        if let EntityType::Ellipse(ellipse) = entity {
            write_common(writer, entity, layer_indices)?;
            write_vec3(writer, ellipse.center)?;
            write_vec3(writer, ellipse.major_axis)?;
            write_vec3(writer, ellipse.normal)?;
            write_f64(writer, ellipse.minor_axis_ratio)?;
            write_f64(writer, ellipse.start_parameter)?;
            write_f64(writer, ellipse.end_parameter)?;
            count += 1;
        }
    }
    finish_fixed_section(
        writer,
        SectionKind::Ellipses,
        ELLIPSE_RECORD_SIZE,
        offset,
        count,
    )
}

fn write_spline_header_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut knot_index = 0_u64;
    let mut weight_index = 0_u64;
    let mut control_index = 0_u64;
    let mut fit_index = 0_u64;
    let mut count = 0_u64;

    for entity in document.entities() {
        let EntityType::Spline(spline) = entity else {
            continue;
        };
        write_common(writer, entity, layer_indices)?;
        write_i32(writer, spline.degree)?;
        let mut flags = 0_u32;
        if spline.flags.closed {
            flags |= 1;
        }
        if spline.flags.periodic {
            flags |= 1 << 1;
        }
        if spline.flags.rational {
            flags |= 1 << 2;
        }
        if spline.flags.planar {
            flags |= 1 << 3;
        }
        if spline.flags.linear {
            flags |= 1 << 4;
        }
        write_u32(writer, flags)?;
        write_i32(writer, spline.knot_parameterization)?;
        write_u32(writer, 0)?;

        write_u64(writer, knot_index)?;
        write_u64(writer, spline.knots.len() as u64)?;
        write_u64(writer, control_index)?;
        write_u64(writer, spline.control_points.len() as u64)?;
        write_u64(writer, weight_index)?;
        write_u64(writer, spline.weights.len() as u64)?;
        write_u64(writer, fit_index)?;
        write_u64(writer, spline.fit_points.len() as u64)?;

        write_vec3(writer, spline.normal)?;
        write_f64(writer, spline.knot_tolerance)?;
        write_f64(writer, spline.control_tolerance)?;
        write_f64(writer, spline.fit_tolerance)?;
        write_vec3(writer, spline.begin_tangent)?;
        write_vec3(writer, spline.end_tangent)?;

        knot_index = knot_index
            .checked_add(spline.knots.len() as u64)
            .context("spline knot index overflow")?;
        weight_index = weight_index
            .checked_add(spline.weights.len() as u64)
            .context("spline weight index overflow")?;
        control_index = control_index
            .checked_add(spline.control_points.len() as u64)
            .context("spline control-point index overflow")?;
        fit_index = fit_index
            .checked_add(spline.fit_points.len() as u64)
            .context("spline fit-point index overflow")?;
        count += 1;
    }

    finish_fixed_section(
        writer,
        SectionKind::SplineHeaders,
        SPLINE_HEADER_RECORD_SIZE,
        offset,
        count,
    )
}

fn write_spline_knot_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    write_spline_scalar_section(writer, document, SectionKind::SplineKnots, |spline| {
        &spline.knots
    })
}

fn write_spline_weight_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    write_spline_scalar_section(writer, document, SectionKind::SplineWeights, |spline| {
        &spline.weights
    })
}

fn write_spline_scalar_section<'a, W, F>(
    writer: &mut W,
    document: &'a CadDocument,
    kind: SectionKind,
    values: F,
) -> Result<SectionEntry>
where
    W: Write + Seek,
    F: Fn(&'a acadrust::entities::Spline) -> &'a [f64],
{
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        if let EntityType::Spline(spline) = entity {
            for value in values(spline) {
                write_f64(writer, *value)?;
                count += 1;
            }
        }
    }
    finish_fixed_section(writer, kind, SPLINE_SCALAR_RECORD_SIZE, offset, count)
}

fn write_spline_control_point_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    write_spline_point_section(
        writer,
        document,
        SectionKind::SplineControlPoints,
        |spline| &spline.control_points,
    )
}

fn write_spline_fit_point_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    write_spline_point_section(writer, document, SectionKind::SplineFitPoints, |spline| {
        &spline.fit_points
    })
}

fn write_spline_point_section<'a, W, F>(
    writer: &mut W,
    document: &'a CadDocument,
    kind: SectionKind,
    points: F,
) -> Result<SectionEntry>
where
    W: Write + Seek,
    F: Fn(&'a acadrust::entities::Spline) -> &'a [Vector3],
{
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        if let EntityType::Spline(spline) = entity {
            for point in points(spline) {
                write_vec3(writer, *point)?;
                count += 1;
            }
        }
    }
    finish_fixed_section(writer, kind, SPLINE_POINT_RECORD_SIZE, offset, count)
}

fn write_common<W: Write>(
    writer: &mut W,
    entity: &EntityType,
    layer_indices: &HashMap<String, u32>,
) -> Result<()> {
    let common = entity.common();
    write_u64(writer, common.handle.value())?;
    write_u64(writer, common.owner_handle.value())?;
    write_u32(
        writer,
        layer_indices
            .get(&common.layer.to_uppercase())
            .copied()
            .unwrap_or(u32::MAX),
    )?;
    write_u32(writer, encode_color(common.color))?;
    write_i16(writer, common.line_weight.value())?;
    let flags = if common.invisible { 1 } else { 0 };
    write_u16(writer, flags)?;
    write_u32(writer, 0)?;
    Ok(())
}

fn drawing_bounds(document: &CadDocument) -> Option<Bounds3> {
    let mut bounds = BoundsAccumulator::default();
    for entity in document.entities() {
        match entity {
            EntityType::Unknown(_) | EntityType::Ray(_) | EntityType::XLine(_) => {}
            _ => bounds.include_entity(entity),
        }
    }
    bounds.finish()
}

fn encode_color(color: Color) -> u32 {
    match color {
        Color::ByLayer => 0,
        Color::ByBlock => 1 << 30,
        Color::Index(index) => (2 << 30) | u32::from(index),
        Color::Rgb { r, g, b } => {
            (3 << 30) | (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b)
        }
    }
}

fn push_string(buffer: &mut Vec<u8>, value: &str) -> Result<(u32, u32)> {
    let offset = u32::try_from(buffer.len()).context("scene-cache string table exceeds 4GB")?;
    let length = u32::try_from(value.len()).context("scene-cache string exceeds 4GB")?;
    buffer.extend_from_slice(value.as_bytes());
    Ok((offset, length))
}

fn aligned_position<W: Write + Seek>(writer: &mut W) -> Result<u64> {
    let current = writer.stream_position()?;
    let aligned = align_up(current, 8);
    if aligned > current {
        writer.write_all(&[0; 8][..usize::try_from(aligned - current)?])?;
    }
    Ok(aligned)
}

fn align_up(value: u64, alignment: u64) -> u64 {
    let mask = alignment - 1;
    (value + mask) & !mask
}

fn finish_fixed_section<W: Seek>(
    writer: &mut W,
    kind: SectionKind,
    record_size: u32,
    offset: u64,
    count: u64,
) -> Result<SectionEntry> {
    let end = writer.stream_position()?;
    let actual_length = end - offset;
    let expected_length = count
        .checked_mul(u64::from(record_size))
        .context("scene-cache section size overflow")?;
    if actual_length != expected_length {
        anyhow::bail!(
            "{} section size mismatch: expected {}, wrote {}",
            kind.name(),
            expected_length,
            actual_length
        );
    }
    Ok(SectionEntry {
        kind,
        record_size,
        offset,
        byte_length: actual_length,
        record_count: count,
        flags: 0,
    })
}

fn finish_variable_section<W: Seek>(
    writer: &mut W,
    kind: SectionKind,
    record_size: u32,
    offset: u64,
    count: u64,
    flags: u32,
) -> Result<SectionEntry> {
    let end = writer.stream_position()?;
    Ok(SectionEntry {
        kind,
        record_size,
        offset,
        byte_length: end - offset,
        record_count: count,
        flags,
    })
}

fn write_vec3<W: Write>(writer: &mut W, value: Vector3) -> Result<()> {
    write_f64(writer, value.x)?;
    write_f64(writer, value.y)?;
    write_f64(writer, value.z)?;
    Ok(())
}

fn write_u16<W: Write>(writer: &mut W, value: u16) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}

fn write_i16<W: Write>(writer: &mut W, value: i16) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}

fn write_u32<W: Write>(writer: &mut W, value: u32) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}

fn write_i32<W: Write>(writer: &mut W, value: i32) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}

fn write_u64<W: Write>(writer: &mut W, value: u64) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}

fn write_f64<W: Write>(writer: &mut W, value: f64) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}

fn slice_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("u16 slice"))
}

fn slice_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("u32 slice"))
}

fn slice_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("u64 slice"))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use acadrust::entities::{Arc, Circle, Ellipse, EntityType, Insert, Line, LwPolyline, Spline};
    use acadrust::types::{Vector2, Vector3};

    use super::*;

    #[test]
    fn cache_header_and_directory_are_stable() {
        let mut document = CadDocument::new();
        document
            .add_entity(EntityType::Line(Line::from_coords(
                1.0, 2.0, 3.0, 4.0, 5.0, 6.0,
            )))
            .unwrap();
        document
            .add_entity(EntityType::Arc(Arc::from_coords(
                10.0,
                20.0,
                0.0,
                5.0,
                0.0,
                std::f64::consts::PI,
            )))
            .unwrap();
        document
            .add_entity(EntityType::Circle(Circle::from_coords(7.0, 8.0, 0.0, 3.0)))
            .unwrap();
        document
            .add_entity(EntityType::Insert(Insert::new(
                "*Model_Space",
                Vector3::new(9.0, 10.0, 0.0),
            )))
            .unwrap();
        document
            .add_entity(EntityType::LwPolyline(LwPolyline::from_points(vec![
                Vector2::new(1.0, 2.0),
                Vector2::new(3.0, 4.0),
            ])))
            .unwrap();
        document
            .add_entity(EntityType::Ellipse(Ellipse::from_center_axes(
                Vector3::new(2.0, 3.0, 0.0),
                Vector3::new(5.0, 0.0, 0.0),
                0.5,
            )))
            .unwrap();
        document
            .add_entity(EntityType::Spline(Spline::from_control_points(
                1,
                vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(1.0, 1.0, 0.0)],
            )))
            .unwrap();

        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 1234).unwrap();
        let bytes = cursor.into_inner();

        assert_eq!(&bytes[0..8], &CACHE_MAGIC);
        assert_eq!(read_u16(&bytes, 8), CACHE_VERSION_MAJOR);
        assert_eq!(read_u32(&bytes, 12), HEADER_SIZE);
        assert_eq!(read_u32(&bytes, 16), 15);
        assert_eq!(read_u64(&bytes, 48), 1234);
        assert_eq!(summary.counts.serialized_entities, 7);

        let validation =
            validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();
        assert_eq!(validation.sections.len(), 15);
        assert_eq!(validation.source_size, 1234);

        let line = directory_entry(&bytes, SectionKind::Lines);
        assert_eq!(line.1, LINE_RECORD_SIZE);
        assert_eq!(line.3, 1);
        let line_offset = usize::try_from(line.2).unwrap();
        assert_eq!(read_f64(&bytes, line_offset + 32), 1.0);
        assert_eq!(read_f64(&bytes, line_offset + 72), 6.0);

        let insert = directory_entry(&bytes, SectionKind::Inserts);
        assert_eq!(insert.1, INSERT_RECORD_SIZE);
        assert_eq!(insert.3, 1);

        let polyline_vertices = directory_entry(&bytes, SectionKind::PolylineVertices);
        assert_eq!(polyline_vertices.1, POLYLINE_VERTEX_RECORD_SIZE);
        assert_eq!(polyline_vertices.3, 2);

        let spline_knots = directory_entry(&bytes, SectionKind::SplineKnots);
        assert_eq!(spline_knots.1, SPLINE_SCALAR_RECORD_SIZE);
        assert_eq!(spline_knots.3, 4);
    }

    #[test]
    fn validation_rejects_a_wrong_declared_file_size() {
        let document = CadDocument::new();
        let mut cursor = Cursor::new(Vec::new());
        write_scene_cache(&mut cursor, &document, 0).unwrap();
        let mut bytes = cursor.into_inner();
        bytes[40..48].copy_from_slice(&1_u64.to_le_bytes());

        let error = validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64)
            .unwrap_err();
        assert!(error.to_string().contains("file-size mismatch"));
    }

    #[test]
    fn validation_rejects_a_string_outside_its_blob() {
        let document = CadDocument::new();
        let mut cursor = Cursor::new(Vec::new());
        write_scene_cache(&mut cursor, &document, 0).unwrap();
        let mut bytes = cursor.into_inner();
        let layer = directory_entry(&bytes, SectionKind::Layers);
        let first_name_offset = usize::try_from(layer.2).unwrap() + 16 + 8;
        bytes[first_name_offset..first_name_offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());

        let error = validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64)
            .unwrap_err();
        assert!(error.to_string().contains("outside its UTF-8 blob"));
    }

    #[test]
    fn validation_rejects_a_polyline_vertex_range_outside_its_pool() {
        let mut document = CadDocument::new();
        document
            .add_entity(EntityType::LwPolyline(LwPolyline::from_points(vec![
                Vector2::new(1.0, 2.0),
                Vector2::new(3.0, 4.0),
            ])))
            .unwrap();
        let mut cursor = Cursor::new(Vec::new());
        write_scene_cache(&mut cursor, &document, 0).unwrap();
        let mut bytes = cursor.into_inner();
        let headers = directory_entry(&bytes, SectionKind::PolylineHeaders);
        let first_vertex_count = usize::try_from(headers.2).unwrap() + 40;
        bytes[first_vertex_count..first_vertex_count + 4].copy_from_slice(&u32::MAX.to_le_bytes());

        let error = validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64)
            .unwrap_err();
        assert!(error.to_string().contains("exceeds its pool"));
    }

    #[test]
    fn color_encoding_keeps_source_semantics() {
        assert_eq!(encode_color(Color::ByLayer), 0);
        assert_eq!(encode_color(Color::ByBlock), 1 << 30);
        assert_eq!(encode_color(Color::Index(7)), (2 << 30) | 7);
        assert_eq!(
            encode_color(Color::Rgb { r: 1, g: 2, b: 3 }),
            (3 << 30) | 0x010203
        );
    }

    #[test]
    fn primitive_counts_track_deferred_entities() {
        let mut document = CadDocument::new();
        document
            .add_entity(EntityType::Line(Line::from_coords(
                0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
            )))
            .unwrap();
        document
            .add_entity(EntityType::Point(acadrust::entities::Point::from_coords(
                2.0, 3.0, 0.0,
            )))
            .unwrap();

        let counts = PrimitiveCounts::from_document(&document);
        assert_eq!(counts.total_entities, 2);
        assert_eq!(counts.serialized_entities, 1);
        assert_eq!(counts.deferred_entities, 1);
    }

    fn directory_entry(bytes: &[u8], expected_kind: SectionKind) -> (u32, u32, u64, u64) {
        let section_count = read_u32(bytes, 16) as usize;
        let directory_offset = read_u64(bytes, 32) as usize;
        for index in 0..section_count {
            let offset = directory_offset + index * DIRECTORY_ENTRY_SIZE as usize;
            let kind = read_u32(bytes, offset);
            if kind == expected_kind as u32 {
                return (
                    kind,
                    read_u32(bytes, offset + 4),
                    read_u64(bytes, offset + 8),
                    read_u64(bytes, offset + 24),
                );
            }
        }
        panic!("missing directory entry: {}", expected_kind.name());
    }

    fn read_u16(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
    }

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn read_u64(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    fn read_f64(bytes: &[u8], offset: usize) -> f64 {
        f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }
}
