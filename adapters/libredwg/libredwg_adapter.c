/*
 * SPDX-License-Identifier: MPL-2.0
 *
 * A small process-isolated adapter for GNU LibreDWG. The resulting binary
 * links to LibreDWG and must be distributed in compliance with LibreDWG's
 * GPL-3.0-or-later license.
 */

#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE 1
#endif

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wextra-semi"
#pragma clang diagnostic ignored "-Wflexible-array-extensions"
#endif
#include <dwg.h>
#include <dwg_api.h>
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

#include "libredwg_scene_cache.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#if defined(__unix__) || defined(__APPLE__)
#include <sys/resource.h>
#endif

#define ADAPTER_PROTOCOL "dwg-engine-adapter/1"
#define REPORT_SCHEMA "dwg-inspection/1"
#define CONVERSION_REPORT_SCHEMA "dwg-scene-cache/1"

typedef struct
{
  const char *name;
  uint64_t count;
} CounterEntry;

typedef struct
{
  CounterEntry *items;
  size_t len;
  size_t capacity;
} CounterMap;

typedef struct
{
  uint64_t entities;
  uint64_t hangul_entities;
  uint64_t hangul_characters;
  uint64_t question_marks;
  uint64_t replacement_characters;
  uint64_t null_characters;
} TextSummary;

typedef struct
{
  double min[3];
  double max[3];
  int present;
} Bounds;

typedef struct
{
  uint64_t entity_handles;
  uint64_t references;
  int present;
} LargestBlock;

static int
read_version_code (const char *path, char version_code[7])
{
  FILE *input = fopen (path, "rb");
  size_t read_size;
  size_t i;
  if (!input)
    return 0;
  read_size = fread (version_code, 1, 6, input);
  if (fclose (input) != 0 || read_size != 6)
    return 0;
  version_code[6] = '\0';
  for (i = 0; i < 6; i++)
    {
      if (version_code[i] < 0x20 || version_code[i] > 0x7e)
        return 0;
    }
  return 1;
}

static void
print_usage (void)
{
  fputs (
      "usage:\n"
      "  libredwg-adapter inspect INPUT [--notification-samples N]\n"
      "  libredwg-adapter convert INPUT OUTPUT\n",
      stderr);
}

static uint32_t
numeric_version_code (const char version_code[7])
{
  char *end = NULL;
  unsigned long value;
  if (version_code[0] != 'A' || version_code[1] != 'C')
    return 0;
  errno = 0;
  value = strtoul (version_code + 2, &end, 10);
  if (errno || !end || end == version_code + 2 || value > UINT32_MAX)
    return 0;
  return (uint32_t)value;
}

static uint64_t
elapsed_ms (const struct timespec *started, const struct timespec *ended)
{
  time_t seconds = ended->tv_sec - started->tv_sec;
  long nanoseconds = ended->tv_nsec - started->tv_nsec;
  if (nanoseconds < 0)
    {
      seconds--;
      nanoseconds += 1000000000L;
    }
  if (seconds < 0)
    return 0;
  return (uint64_t)seconds * 1000u + (uint64_t)nanoseconds / 1000000u;
}

static uint64_t
peak_rss_bytes (void)
{
#if defined(__unix__) || defined(__APPLE__)
  struct rusage usage;
  if (getrusage (RUSAGE_SELF, &usage) != 0 || usage.ru_maxrss < 0)
    return 0;
#if defined(__APPLE__)
  return (uint64_t)usage.ru_maxrss;
#else
  return (uint64_t)usage.ru_maxrss * 1024u;
#endif
#else
  return 0;
#endif
}

static int
read_dwg_quietly (const char *path, Dwg_Data *dwg, unsigned int *error)
{
  int saved_stderr = dup (STDERR_FILENO);
  int sink;
  int restored;

  if (saved_stderr < 0)
    return 0;
  sink = open ("/dev/null", O_WRONLY);
  if (sink < 0)
    {
      close (saved_stderr);
      return 0;
    }

  (void)fflush (stderr);
  if (dup2 (sink, STDERR_FILENO) < 0)
    {
      close (sink);
      close (saved_stderr);
      return 0;
    }
  close (sink);

  *error = (unsigned int)dwg_read_file (path, dwg);
  (void)fflush (stderr);
  restored = dup2 (saved_stderr, STDERR_FILENO);
  close (saved_stderr);
  return restored >= 0;
}

static int
counter_compare (const void *left, const void *right)
{
  const CounterEntry *a = (const CounterEntry *)left;
  const CounterEntry *b = (const CounterEntry *)right;
  return strcmp (a->name, b->name);
}

static int
counter_add (CounterMap *map, const char *name)
{
  size_t i;
  CounterEntry *items;
  size_t new_capacity;

  for (i = 0; i < map->len; i++)
    {
      if (strcmp (map->items[i].name, name) == 0)
        {
          map->items[i].count++;
          return 1;
        }
    }

  if (map->len == map->capacity)
    {
      new_capacity = map->capacity == 0 ? 32 : map->capacity * 2;
      if (new_capacity < map->capacity
          || new_capacity > SIZE_MAX / sizeof (CounterEntry))
        return 0;
      items
          = (CounterEntry *)realloc (map->items,
                                    new_capacity * sizeof (CounterEntry));
      if (!items)
        return 0;
      map->items = items;
      map->capacity = new_capacity;
    }

  map->items[map->len].name = name;
  map->items[map->len].count = 1;
  map->len++;
  return 1;
}

static uint64_t
counter_total (const CounterMap *map)
{
  uint64_t total = 0;
  size_t i;
  for (i = 0; i < map->len; i++)
    total += map->items[i].count;
  return total;
}

static void
json_string (const char *value)
{
  const unsigned char *cursor = (const unsigned char *)value;
  putchar ('"');
  while (*cursor)
    {
      unsigned char byte = *cursor++;
      switch (byte)
        {
        case '"':
          fputs ("\\\"", stdout);
          break;
        case '\\':
          fputs ("\\\\", stdout);
          break;
        case '\b':
          fputs ("\\b", stdout);
          break;
        case '\f':
          fputs ("\\f", stdout);
          break;
        case '\n':
          fputs ("\\n", stdout);
          break;
        case '\r':
          fputs ("\\r", stdout);
          break;
        case '\t':
          fputs ("\\t", stdout);
          break;
        default:
          if (byte >= 0x20 && byte <= 0x7e)
            putchar ((int)byte);
          else
            printf ("\\u%04x", (unsigned int)byte);
          break;
        }
    }
  putchar ('"');
}

static void
json_counter_map (const CounterMap *map)
{
  size_t i;
  putchar ('{');
  for (i = 0; i < map->len; i++)
    {
      if (i)
        putchar (',');
      json_string (map->items[i].name);
      printf (":%" PRIu64, map->items[i].count);
    }
  putchar ('}');
}

static uint32_t
next_utf8 (const unsigned char **cursor)
{
  const unsigned char *value = *cursor;
  uint32_t codepoint;
  unsigned int needed;
  unsigned int i;

  if (value[0] < 0x80)
    {
      *cursor = value + 1;
      return value[0];
    }
  if (value[0] >= 0xc2 && value[0] <= 0xdf)
    {
      codepoint = value[0] & 0x1f;
      needed = 1;
    }
  else if (value[0] >= 0xe0 && value[0] <= 0xef)
    {
      codepoint = value[0] & 0x0f;
      needed = 2;
    }
  else if (value[0] >= 0xf0 && value[0] <= 0xf4)
    {
      codepoint = value[0] & 0x07;
      needed = 3;
    }
  else
    {
      *cursor = value + 1;
      return 0xfffd;
    }

  for (i = 1; i <= needed; i++)
    {
      if (value[i] == '\0' || (value[i] & 0xc0) != 0x80)
        {
          *cursor = value + 1;
          return 0xfffd;
        }
      codepoint = (codepoint << 6) | (uint32_t)(value[i] & 0x3f);
    }

  if ((needed == 2 && codepoint < 0x800)
      || (needed == 3 && codepoint < 0x10000)
      || (codepoint >= 0xd800 && codepoint <= 0xdfff)
      || codepoint > 0x10ffff)
    {
      *cursor = value + 1;
      return 0xfffd;
    }

  *cursor = value + needed + 1;
  return codepoint;
}

static int
is_hangul (uint32_t codepoint)
{
  return (codepoint >= 0x1100 && codepoint <= 0x11ff)
         || (codepoint >= 0x3130 && codepoint <= 0x318f)
         || (codepoint >= 0xa960 && codepoint <= 0xa97f)
         || (codepoint >= 0xac00 && codepoint <= 0xd7a3)
         || (codepoint >= 0xd7b0 && codepoint <= 0xd7ff);
}

static void
text_include (TextSummary *summary, const char *value)
{
  const unsigned char *cursor = (const unsigned char *)value;
  uint64_t hangul_characters = 0;

  summary->entities++;
  if (!value)
    return;

  while (*cursor)
    {
      uint32_t codepoint = next_utf8 (&cursor);
      if (is_hangul (codepoint))
        hangul_characters++;
      if (codepoint == '?')
        summary->question_marks++;
      if (codepoint == 0xfffd)
        summary->replacement_characters++;
      if (codepoint == 0)
        summary->null_characters++;
    }

  if (hangul_characters)
    {
      summary->hangul_entities++;
      summary->hangul_characters += hangul_characters;
    }
}

static void
inspect_text_entity (Dwg_Object *object, TextSummary *summary)
{
  void *entity = NULL;
  const char *name = NULL;
  const char *field = NULL;
  char *text = NULL;
  int is_new = 0;

  if (!object->tio.entity)
    return;

  switch (object->fixedtype)
    {
    case DWG_TYPE_TEXT:
      entity = object->tio.entity->tio.TEXT;
      name = "TEXT";
      field = "text_value";
      break;
    case DWG_TYPE_MTEXT:
      entity = object->tio.entity->tio.MTEXT;
      name = "MTEXT";
      field = "text";
      break;
    case DWG_TYPE_ATTRIB:
      entity = object->tio.entity->tio.ATTRIB;
      name = "ATTRIB";
      field = "text_value";
      break;
    case DWG_TYPE_ATTDEF:
      entity = object->tio.entity->tio.ATTDEF;
      name = "ATTDEF";
      field = "default_value";
      break;
    default:
      return;
    }

  if (!entity)
    return;

  if (dwg_dynapi_entity_utf8text (entity, name, field, &text, &is_new, NULL))
    text_include (summary, text);
  else
    text_include (summary, NULL);
  if (is_new)
    free (text);
}

static int
is_structural_entity (Dwg_Object_Type type)
{
  switch (type)
    {
    case DWG_TYPE_BLOCK:
    case DWG_TYPE_ENDBLK:
    case DWG_TYPE_SEQEND:
    case DWG_TYPE_VERTEX_2D:
    case DWG_TYPE_VERTEX_3D:
    case DWG_TYPE_VERTEX_MESH:
    case DWG_TYPE_VERTEX_PFACE:
    case DWG_TYPE_VERTEX_PFACE_FACE:
      return 1;
    default:
      return 0;
    }
}

static const char *
logical_entity_name (const Dwg_Object *object)
{
  switch (object->fixedtype)
    {
    case DWG_TYPE_DIMENSION_ANG2LN:
      return "DIMENSION_ANGULAR_2LINE";
    case DWG_TYPE_POLYLINE_2D:
      return "POLYLINE";
    default:
      return object->dxfname
                 ? object->dxfname
                 : (object->name ? object->name : "UNKNOWN_ENT");
    }
}

static Bounds
drawing_bounds (const Dwg_Data *dwg)
{
  Bounds bounds = { { 0, 0, 0 }, { 0, 0, 0 }, 0 };
  size_t i;

  bounds.min[0] = dwg_model_x_min (dwg);
  bounds.min[1] = dwg_model_y_min (dwg);
  bounds.min[2] = dwg_model_z_min (dwg);
  bounds.max[0] = dwg_model_x_max (dwg);
  bounds.max[1] = dwg_model_y_max (dwg);
  bounds.max[2] = dwg_model_z_max (dwg);
  bounds.present = 1;

  for (i = 0; i < 3; i++)
    {
      if (!isfinite (bounds.min[i]) || !isfinite (bounds.max[i])
          || bounds.min[i] > bounds.max[i])
        {
          bounds.present = 0;
          break;
        }
    }
  return bounds;
}

typedef struct
{
  unsigned int bit;
  const char *name;
} DiagnosticBit;

static const DiagnosticBit DIAGNOSTIC_BITS[]
    = { { DWG_ERR_WRONGCRC, "wrong_crc" },
        { DWG_ERR_NOTYETSUPPORTED, "not_yet_supported" },
        { DWG_ERR_UNHANDLEDCLASS, "unhandled_class" },
        { DWG_ERR_INVALIDTYPE, "invalid_type" },
        { DWG_ERR_INVALIDHANDLE, "invalid_handle" },
        { DWG_ERR_INVALIDEED, "invalid_eed" },
        { DWG_ERR_VALUEOUTOFBOUNDS, "value_out_of_bounds" },
        { DWG_ERR_CLASSESNOTFOUND, "classes_not_found" },
        { DWG_ERR_SECTIONNOTFOUND, "section_not_found" },
        { DWG_ERR_PAGENOTFOUND, "page_not_found" },
        { DWG_ERR_INTERNALERROR, "internal_error" },
        { DWG_ERR_INVALIDDWG, "invalid_dwg" },
        { DWG_ERR_IOERROR, "io_error" },
        { DWG_ERR_OUTOFMEM, "out_of_memory" } };

static uint64_t
diagnostic_count (unsigned int error)
{
  uint64_t count = 0;
  size_t i;
  for (i = 0; i < sizeof (DIAGNOSTIC_BITS) / sizeof (DIAGNOSTIC_BITS[0]); i++)
    {
      if (error & DIAGNOSTIC_BITS[i].bit)
        count++;
    }
  return count;
}

static void
json_diagnostics (unsigned int error)
{
  size_t i;
  int comma = 0;
  printf ("{\"count\":%" PRIu64 ",\"by_type\":{",
          diagnostic_count (error));
  for (i = 0; i < sizeof (DIAGNOSTIC_BITS) / sizeof (DIAGNOSTIC_BITS[0]); i++)
    {
      if (!(error & DIAGNOSTIC_BITS[i].bit))
        continue;
      if (comma)
        putchar (',');
      json_string (DIAGNOSTIC_BITS[i].name);
      fputs (":1", stdout);
      comma = 1;
    }
  fputs ("}}", stdout);
}

static int
validate_environment (const char *command)
{
  const char *protocol = getenv ("DWG_VIEWER_ADAPTER_PROTOCOL");
  const char *phase = getenv ("DWG_VIEWER_BENCHMARK_PHASE");
  if (protocol && strcmp (protocol, ADAPTER_PROTOCOL) != 0)
    {
      fputs ("unsupported adapter protocol\n", stderr);
      return 0;
    }
  if (phase && strcmp (phase, command) != 0)
    {
      fputs ("unsupported benchmark phase\n", stderr);
      return 0;
    }
  return 1;
}

static int
validate_arguments (int argc, char **argv)
{
  int i;
  if (argc >= 2 && strcmp (argv[1], "convert") == 0)
    return argc == 4;
  if (argc < 3 || strcmp (argv[1], "inspect") != 0)
    return 0;
  for (i = 3; i < argc; i++)
    {
      if (strcmp (argv[i], "--notification-samples") == 0 && i + 1 < argc)
        {
          char *end = NULL;
          errno = 0;
          (void)strtoull (argv[++i], &end, 10);
          if (errno || !end || *end != '\0')
            return 0;
        }
      else
        {
          return 0;
        }
    }
  return 1;
}

static int
inspect_dwg (const char *path)
{
  struct stat metadata;
  struct timespec started;
  struct timespec parsed;
  struct timespec analyzed;
  Dwg_Data dwg;
  CounterMap entity_types = { 0 };
  CounterMap unknown_types = { 0 };
  TextSummary text = { 0 };
  TextSummary embedded_text = { 0 };
  LargestBlock largest_block = { 0, 0, 0 };
  Bounds bounds;
  char version_code[7];
  uint64_t raw_entities = 0;
  uint64_t entities = 0;
  uint64_t structural_entities = 0;
  uint64_t embedded_attributes = 0;
  uint64_t raw_objects = 0;
  uint64_t table_objects = 0;
  uint64_t layers = 0;
  uint64_t text_styles = 0;
  uint64_t blocks = 0;
  uint64_t block_references = 0;
  uint64_t objects;
  uint64_t peak_rss;
  uint64_t parse_ms;
  uint64_t analysis_ms;
  uint64_t total_ms;
  unsigned int error;
  size_t i;
  int result = 1;

  if (stat (path, &metadata) != 0 || !S_ISREG (metadata.st_mode)
      || metadata.st_size < 0)
    {
      fputs ("input is not a readable regular file\n", stderr);
      return 1;
    }
  if (!read_version_code (path, version_code))
    {
      fputs ("cannot read DWG version code\n", stderr);
      return 1;
    }

  memset (&dwg, 0, sizeof (dwg));
  dwg.opts = 0;
  if (clock_gettime (CLOCK_MONOTONIC, &started) != 0)
    {
      fputs ("cannot start monotonic timer\n", stderr);
      return 1;
    }

  if (!read_dwg_quietly (path, &dwg, &error))
    {
      fputs ("cannot isolate LibreDWG diagnostics\n", stderr);
      goto done;
    }
  if (clock_gettime (CLOCK_MONOTONIC, &parsed) != 0)
    {
      fputs ("cannot read monotonic timer\n", stderr);
      goto done;
    }
  if (error >= DWG_ERR_CRITICAL)
    {
      fprintf (stderr, "LibreDWG parse failed (0x%x)\n", error);
      goto done;
    }

  for (i = 0; i < (size_t)dwg.num_objects; i++)
    {
      Dwg_Object *object = &dwg.object[i];
      const char *name;

      if (object->fixedtype == DWG_TYPE_LAYER)
        layers++;
      else if (object->fixedtype == DWG_TYPE_STYLE)
        text_styles++;
      else if (object->fixedtype == DWG_TYPE_BLOCK_HEADER)
        {
          Dwg_Object_BLOCK_HEADER *block = NULL;
          blocks++;
          if (object->tio.object)
            block = object->tio.object->tio.BLOCK_HEADER;
          if (block && (!largest_block.present
                        || (uint64_t)block->num_owned
                               > largest_block.entity_handles))
            {
              largest_block.present = 1;
              largest_block.entity_handles = (uint64_t)block->num_owned;
              largest_block.references = (uint64_t)block->num_inserts;
            }
        }

      if (object->supertype != DWG_SUPERTYPE_ENTITY)
        {
          raw_objects++;
          if (dwg_obj_is_table (object) || dwg_obj_is_control (object))
            table_objects++;
          continue;
        }

      raw_entities++;
      if (is_structural_entity (object->fixedtype))
        {
          structural_entities++;
          continue;
        }
      if (object->fixedtype == DWG_TYPE_ATTRIB)
        {
          embedded_attributes++;
          inspect_text_entity (object, &embedded_text);
          continue;
        }

      entities++;
      name = logical_entity_name (object);
      if (!counter_add (&entity_types, name))
        {
          fputs ("out of memory while counting entity types\n", stderr);
          goto done;
        }

      if (object->fixedtype == DWG_TYPE_INSERT
          || object->fixedtype == DWG_TYPE_MINSERT)
        block_references++;

      if (object->fixedtype == DWG_TYPE_UNKNOWN_ENT
          || object->fixedtype == DWG_TYPE_PROXY_ENTITY)
        {
          if (!counter_add (&unknown_types, name))
            {
              fputs ("out of memory while counting unknown entities\n",
                     stderr);
              goto done;
            }
        }

      inspect_text_entity (object, &text);
    }

  qsort (entity_types.items, entity_types.len, sizeof (CounterEntry),
         counter_compare);
  qsort (unknown_types.items, unknown_types.len, sizeof (CounterEntry),
         counter_compare);
  bounds = drawing_bounds (&dwg);
  if (clock_gettime (CLOCK_MONOTONIC, &analyzed) != 0)
    {
      fputs ("cannot read monotonic timer\n", stderr);
      goto done;
    }

  parse_ms = elapsed_ms (&started, &parsed);
  analysis_ms = elapsed_ms (&parsed, &analyzed);
  total_ms = elapsed_ms (&started, &analyzed);
  peak_rss = peak_rss_bytes ();
  objects = raw_objects - table_objects;

  fputs ("{\"schema\":\"" REPORT_SCHEMA "\",\"status\":\"ok\",", stdout);
  printf ("\"input\":{\"size_bytes\":%" PRIu64 "},",
          (uint64_t)metadata.st_size);
  fputs ("\"drawing\":{", stdout);
  fputs ("\"version\":", stdout);
  json_string (version_code);
  printf (",\"maintenance_version\":%u",
          (unsigned int)LIBREDWG_MAINTENANCE_VERSION (&dwg));
  printf (",\"entities\":%" PRIu64, entities);
  printf (",\"raw_entities\":%" PRIu64, raw_entities);
  printf (",\"structural_entities\":%" PRIu64, structural_entities);
  printf (",\"embedded_attributes\":%" PRIu64, embedded_attributes);
  printf (",\"objects\":%" PRIu64, objects);
  printf (",\"raw_objects\":%" PRIu64, raw_objects);
  printf (",\"table_objects\":%" PRIu64, table_objects);
  printf (",\"layers\":%" PRIu64, layers);
  printf (",\"text_styles\":%" PRIu64, text_styles);
  printf (",\"blocks\":%" PRIu64, blocks);
  printf (",\"block_references\":%" PRIu64, block_references);
  if (largest_block.present)
    {
      printf (",\"largest_block\":{\"name\":\"\",\"entity_handles\":%" PRIu64
              ",\"references\":%" PRIu64 "}",
              largest_block.entity_handles, largest_block.references);
    }
  else
    {
      fputs (",\"largest_block\":null", stdout);
    }
  fputs ("},", stdout);

  printf ("\"performance\":{\"parse_ms\":%" PRIu64
          ",\"analysis_ms\":%" PRIu64 ",\"total_ms\":%" PRIu64,
          parse_ms, analysis_ms, total_ms);
  if (peak_rss)
    printf (",\"peak_rss_bytes\":%" PRIu64, peak_rss);
  fputs ("},\"entity_types\":", stdout);
  json_counter_map (&entity_types);
  fputs (",\"unknown_entities\":{\"count\":", stdout);
  printf ("%" PRIu64 ",\"by_name\":", counter_total (&unknown_types));
  json_counter_map (&unknown_types);
  fputs ("},\"text\":{", stdout);
  printf ("\"entities\":%" PRIu64, text.entities);
  printf (",\"hangul_entities\":%" PRIu64, text.hangul_entities);
  printf (",\"hangul_characters\":%" PRIu64, text.hangul_characters);
  printf (",\"question_marks\":%" PRIu64, text.question_marks);
  printf (",\"replacement_characters\":%" PRIu64,
          text.replacement_characters);
  printf (",\"null_characters\":%" PRIu64, text.null_characters);
  fputs ("},\"embedded_text\":{", stdout);
  printf ("\"entities\":%" PRIu64, embedded_text.entities);
  printf (",\"hangul_entities\":%" PRIu64, embedded_text.hangul_entities);
  printf (",\"hangul_characters\":%" PRIu64,
          embedded_text.hangul_characters);
  printf (",\"question_marks\":%" PRIu64, embedded_text.question_marks);
  printf (",\"replacement_characters\":%" PRIu64,
          embedded_text.replacement_characters);
  printf (",\"null_characters\":%" PRIu64, embedded_text.null_characters);
  fputs ("},\"bounds\":", stdout);
  if (bounds.present)
    {
      printf ("{\"min\":[%.17g,%.17g,%.17g],\"max\":[%.17g,%.17g,%.17g]}",
              bounds.min[0], bounds.min[1], bounds.min[2], bounds.max[0],
              bounds.max[1], bounds.max[2]);
    }
  else
    {
      fputs ("null", stdout);
    }
  fputs (",\"diagnostics\":", stdout);
  json_diagnostics (error);
  fputs ("}\n", stdout);
  if (fflush (stdout) != 0 || ferror (stdout))
    {
      fputs ("cannot write adapter report\n", stderr);
      goto done;
    }
  result = 0;

done:
  free (entity_types.items);
  free (unknown_types.items);
  if (dwg.header.version && dwg.num_objects < 1000)
    dwg_free (&dwg);
  return result;
}

static void
json_conversion_coverage (const LibreDwgPrimitiveCounts *counts)
{
  fputs ("{\"total_entities\":", stdout);
  printf ("%" PRIu64, counts->total_entities);
  printf (",\"serialized_entities\":%" PRIu64,
          counts->serialized_entities);
  printf (",\"deferred_entities\":%" PRIu64, counts->deferred_entities);
  printf (",\"lines\":%" PRIu64, counts->lines);
  printf (",\"arcs\":%" PRIu64, counts->arcs);
  printf (",\"circles\":%" PRIu64, counts->circles);
  printf (",\"inserts\":%" PRIu64, counts->inserts);
  printf (",\"dimensions\":%" PRIu64, counts->dimensions);
  printf (",\"lwpolylines\":%" PRIu64, counts->lwpolylines);
  printf (",\"polylines_2d\":%" PRIu64, counts->polylines_2d);
  printf (",\"polylines_3d\":%" PRIu64, counts->polylines_3d);
  printf (",\"polyline_vertices\":%" PRIu64,
          counts->polyline_vertices);
  printf (",\"ellipses\":%" PRIu64, counts->ellipses);
  printf (",\"splines\":%" PRIu64, counts->splines);
  printf (",\"spline_knots\":%" PRIu64, counts->spline_knots);
  printf (",\"spline_weights\":%" PRIu64, counts->spline_weights);
  printf (",\"spline_control_points\":%" PRIu64,
          counts->spline_control_points);
  printf (",\"spline_fit_points\":%" PRIu64,
          counts->spline_fit_points);
  printf (",\"texts\":%" PRIu64, counts->texts);
  printf (",\"mtexts\":%" PRIu64, counts->mtexts);
  printf (",\"attribute_definitions\":%" PRIu64,
          counts->attribute_definitions);
  printf (",\"attributes\":%" PRIu64, counts->attributes);
  printf (",\"hatches\":%" PRIu64, counts->hatches);
  printf (",\"points\":%" PRIu64, counts->points);
  printf (",\"solids\":%" PRIu64, counts->solids);
  printf (",\"faces\":%" PRIu64, counts->faces);
  printf (",\"wipeouts\":%" PRIu64, counts->wipeouts);
  putchar ('}');
}

static void
json_gpu_lines (const LibreDwgGpuLineSummary *summary)
{
  fputs ("{\"model_segments\":", stdout);
  printf ("%" PRIu64, summary->model_segments);
  printf (",\"block_segments\":%" PRIu64, summary->block_segments);
  printf (",\"overview_segments\":%" PRIu64,
          summary->overview_segments);
  printf (",\"approximated_curve_segments\":%" PRIu64,
          summary->approximated_curve_segments);
  printf (",\"hatch_boundary_segments\":%" PRIu64,
          summary->hatch_boundary_segments);
  printf (",\"truncated_hatch_entities\":%" PRIu64,
          summary->truncated_hatch_entities);
  printf (",\"skipped_non_finite_segments\":%" PRIu64,
          summary->skipped_non_finite_segments);
  printf (",\"batches\":%" PRIu64, summary->batches);
  printf (",\"model_overview_batches\":%" PRIu64,
          summary->model_overview_batches);
  printf (",\"model_detail_batches\":%" PRIu64,
          summary->model_detail_batches);
  printf (",\"block_batches\":%" PRIu64, summary->block_batches);
  printf (",\"block_overview_batches\":%" PRIu64,
          summary->block_overview_batches);
  printf (",\"block_detail_batches\":%" PRIu64,
          summary->block_detail_batches);
  printf (",\"vertices\":%" PRIu64, summary->vertices);
  printf (",\"cached_vertex_bytes\":%" PRIu64,
          summary->cached_vertex_bytes);
  printf (",\"first_frame_vertex_bytes\":%" PRIu64,
          summary->first_frame_vertex_bytes);
  printf (",\"full_detail_vertex_bytes\":%" PRIu64,
          summary->full_detail_vertex_bytes);
  printf (",\"maximum_batch_bytes\":%" PRIu64,
          summary->maximum_batch_bytes);
  printf (",\"maximum_position_error\":%.17g",
          summary->maximum_position_error);
  putchar ('}');
}

static void
json_hatch_fills (const LibreDwgHatchFillSummary *summary)
{
  fputs ("{\"source_hatches\":", stdout);
  printf ("%" PRIu64, summary->source_hatches);
  printf (",\"solid_hatches\":%" PRIu64, summary->solid_hatches);
  printf (",\"gradient_hatches\":%" PRIu64,
          summary->gradient_hatches);
  printf (",\"pattern_hatches\":%" PRIu64, summary->pattern_hatches);
  printf (",\"fill_loops\":%" PRIu64, summary->fill_loops);
  printf (",\"fill_vertices\":%" PRIu64, summary->fill_vertices);
  printf (",\"gradient_colors\":%" PRIu64,
          summary->gradient_colors);
  printf (",\"seed_points\":%" PRIu64, summary->seed_points);
  printf (",\"pattern_definition_lines\":%" PRIu64,
          summary->pattern_definition_lines);
  printf (",\"pattern_dashes\":%" PRIu64,
          summary->pattern_dashes);
  printf (",\"truncated_fill_hatches\":%" PRIu64,
          summary->truncated_fill_hatches);
  printf (",\"truncated_pattern_hatches\":%" PRIu64,
          summary->truncated_pattern_hatches);
  printf (",\"skipped_open_paths\":%" PRIu64,
          summary->skipped_open_paths);
  printf (",\"skipped_invalid_paths\":%" PRIu64,
          summary->skipped_invalid_paths);
  printf (",\"skipped_invalid_pattern_lines\":%" PRIu64,
          summary->skipped_invalid_pattern_lines);
  putchar ('}');
}

static int
convert_dwg (const char *path, const char *output_path)
{
  struct stat metadata;
  struct timespec started;
  struct timespec parsed;
  struct timespec written;
  Dwg_Data dwg;
  LibreDwgSceneCacheReport report;
  char version_code[7];
  char cache_error[160];
  uint64_t parse_ms;
  uint64_t write_ms;
  uint64_t total_ms;
  uint64_t peak_rss;
  unsigned int error;
  size_t i;
  int result = 1;

  if (stat (path, &metadata) != 0 || !S_ISREG (metadata.st_mode)
      || metadata.st_size < 0)
    {
      fputs ("input is not a readable regular file\n", stderr);
      return 1;
    }
  if (!read_version_code (path, version_code))
    {
      fputs ("cannot read DWG version code\n", stderr);
      return 1;
    }
  memset (&dwg, 0, sizeof (dwg));
  dwg.opts = 0;
  if (clock_gettime (CLOCK_MONOTONIC, &started) != 0)
    {
      fputs ("cannot start monotonic timer\n", stderr);
      return 1;
    }
  if (!read_dwg_quietly (path, &dwg, &error))
    {
      fputs ("cannot isolate LibreDWG diagnostics\n", stderr);
      goto done;
    }
  if (clock_gettime (CLOCK_MONOTONIC, &parsed) != 0)
    {
      fputs ("cannot read monotonic timer\n", stderr);
      goto done;
    }
  if (error >= DWG_ERR_CRITICAL)
    {
      fprintf (stderr, "LibreDWG parse failed (0x%x)\n", error);
      goto done;
    }
  if (!libredwg_write_scene_cache (
          &dwg, output_path, (uint64_t)metadata.st_size,
          numeric_version_code (version_code), &report, cache_error,
          sizeof (cache_error)))
    {
      fprintf (stderr, "LibreDWG scene-cache conversion failed: %s\n",
               cache_error[0] ? cache_error : "unknown writer error");
      goto done;
    }
  if (clock_gettime (CLOCK_MONOTONIC, &written) != 0)
    {
      fputs ("cannot read monotonic timer\n", stderr);
      goto done;
    }
  parse_ms = elapsed_ms (&started, &parsed);
  write_ms = elapsed_ms (&parsed, &written);
  total_ms = elapsed_ms (&started, &written);
  peak_rss = peak_rss_bytes ();

  fputs ("{\"schema\":\"" CONVERSION_REPORT_SCHEMA
         "\",\"status\":\"ok\",",
         stdout);
  printf ("\"input\":{\"size_bytes\":%" PRIu64 "},",
          (uint64_t)metadata.st_size);
  printf ("\"cache\":{\"format_major\":%u,\"format_minor\":%u,"
          "\"size_bytes\":%" PRIu64 ",\"validated\":true,\"sections\":[",
          LIBREDWG_SCENE_CACHE_VERSION_MAJOR,
          LIBREDWG_SCENE_CACHE_VERSION_MINOR, report.cache_size);
  for (i = 0; i < LIBREDWG_SCENE_SECTION_COUNT; i++)
    {
      if (i)
        putchar (',');
      fputs ("{\"kind\":", stdout);
      json_string (report.sections[i].name);
      printf (",\"records\":%" PRIu64 ",\"bytes\":%" PRIu64 "}",
              report.sections[i].records, report.sections[i].bytes);
    }
  fputs ("]},\"coverage\":", stdout);
  json_conversion_coverage (&report.coverage);
  fputs (",\"gpu_lines\":", stdout);
  json_gpu_lines (&report.gpu_lines);
  fputs (",\"hatch_fills\":", stdout);
  json_hatch_fills (&report.hatch_fills);
  printf (",\"performance\":{\"parse_ms\":%" PRIu64
          ",\"write_ms\":%" PRIu64 ",\"total_ms\":%" PRIu64,
          parse_ms, write_ms, total_ms);
  if (peak_rss)
    printf (",\"peak_rss_bytes\":%" PRIu64, peak_rss);
  printf ("},\"diagnostics\":%" PRIu64 "}\n",
          diagnostic_count (error));
  if (fflush (stdout) != 0 || ferror (stdout))
    {
      fputs ("cannot write adapter report\n", stderr);
      goto done;
    }
  result = 0;

done:
  if (dwg.header.version && dwg.num_objects < 1000)
    dwg_free (&dwg);
  return result;
}

int
main (int argc, char **argv)
{
  if (!validate_arguments (argc, argv)
      || !validate_environment (argc >= 2 ? argv[1] : ""))
    {
      print_usage ();
      return 2;
    }
  if (strcmp (argv[1], "convert") == 0)
    return convert_dwg (argv[2], argv[3]);
  return inspect_dwg (argv[2]);
}
