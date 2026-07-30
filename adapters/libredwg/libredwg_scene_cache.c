/*
 * SPDX-License-Identifier: MPL-2.0
 *
 * A bounded-memory Scene Cache v1.3 writer for GNU LibreDWG. Geometry is
 * traversed repeatedly and written directly to the destination; the writer
 * never creates a JSON or whole-drawing intermediate representation.
 */

#define _POSIX_C_SOURCE 200809L
#define _FILE_OFFSET_BITS 64

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
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define CACHE_VERSION_MAJOR 1u
#define CACHE_VERSION_MINOR 3u
#define CACHE_HEADER_SIZE 64u
#define DIRECTORY_ENTRY_SIZE 40u
#define SECTION_FLAG_STRING_TABLE 1u
#define STRING_TABLE_HEADER_SIZE 16u
#define MAX_CACHE_STRING_BYTES (1024u * 1024u)
#define GPU_BATCH_SEGMENTS 8192u
#define SCENE_OVERVIEW_SEGMENTS 65536u
#define GPU_LINE_VERTEX_RECORD_SIZE 32u
#define GPU_STYLE_INVISIBLE (1u << 16)

enum
{
  SECTION_DRAWING = 1,
  SECTION_LAYERS = 2,
  SECTION_BLOCKS = 3,
  SECTION_LINES = 10,
  SECTION_ARCS = 11,
  SECTION_CIRCLES = 12,
  SECTION_INSERTS = 13,
  SECTION_POLYLINE_HEADERS = 14,
  SECTION_POLYLINE_VERTICES = 15,
  SECTION_ELLIPSES = 16,
  SECTION_SPLINE_HEADERS = 17,
  SECTION_SPLINE_KNOTS = 18,
  SECTION_SPLINE_WEIGHTS = 19,
  SECTION_SPLINE_CONTROL_POINTS = 20,
  SECTION_SPLINE_FIT_POINTS = 21,
  SECTION_GPU_LINE_BATCHES = 30,
  SECTION_GPU_LINE_VERTICES = 31
};

enum
{
  DRAWING_RECORD_SIZE = 80,
  LAYER_RECORD_SIZE = 40,
  BLOCK_RECORD_SIZE = 64,
  LINE_RECORD_SIZE = 80,
  ARC_RECORD_SIZE = 112,
  CIRCLE_RECORD_SIZE = 96,
  INSERT_RECORD_SIZE = 136,
  POLYLINE_HEADER_RECORD_SIZE = 112,
  POLYLINE_VERTEX_RECORD_SIZE = 64,
  ELLIPSE_RECORD_SIZE = 128,
  SPLINE_HEADER_RECORD_SIZE = 208,
  SPLINE_SCALAR_RECORD_SIZE = 8,
  SPLINE_POINT_RECORD_SIZE = 24,
  GPU_LINE_BATCH_RECORD_SIZE = 128
};

typedef struct
{
  uint32_t kind;
  uint32_t record_size;
  uint64_t offset;
  uint64_t byte_length;
  uint64_t record_count;
  uint32_t flags;
  const char *name;
} SectionEntry;

typedef struct
{
  Dwg_Object *object;
  uint64_t handle;
  char *name;
  char *linetype;
} LayerEntry;

typedef struct
{
  Dwg_Object *object;
  uint64_t handle;
  char *name;
  int is_model;
  int is_paper;
} BlockEntry;

typedef struct
{
  uint64_t handle;
  uint32_t index;
} HandleIndex;

typedef struct
{
  LayerEntry *layers;
  size_t layer_count;
  HandleIndex *layer_indices;
  BlockEntry *blocks;
  size_t block_count;
  HandleIndex *block_indices;
  uint64_t model_handle;
  uint64_t paper_handle;
} CacheTables;

typedef struct
{
  FILE *file;
  char *error;
  size_t error_size;
  int failed;
} CacheWriter;

typedef struct
{
  double start[3];
  double end[3];
  uint64_t handle;
  uint32_t layer_index;
  uint32_t color;
  int16_t line_weight;
  uint16_t flags;
  uint32_t group;
} LineSegment;

typedef int (*LineSegmentConsumer) (void *context,
                                    const LineSegment *segment);

typedef struct
{
  CacheWriter *writer;
  LibreDwgGpuLineSummary *summary;
  uint32_t current_group;
  uint32_t count;
  uint16_t lod_level;
  int separate_overview;
  int has_group;
  double min[3];
  double max[3];
  uint64_t first_vertex;
} BatchDirectoryBuilder;

typedef struct
{
  CacheWriter *writer;
  LineSegment *segments;
  uint32_t current_group;
  uint32_t count;
  int has_group;
  uint64_t vertices;
} VertexBuilder;

typedef struct
{
  uint64_t count;
  uint64_t quota;
  uint64_t seen;
  uint64_t emitted;
} OverviewGroup;

typedef struct
{
  OverviewGroup *groups;
  size_t group_count;
  uint64_t quota_total;
} OverviewPlan;

typedef struct
{
  uint64_t value;
  size_t index;
} GroupRank;

static const uint8_t CACHE_MAGIC[8]
    = { 'D', 'W', 'G', 'S', 'C', 'N', '1', '\0' };

static const uint32_t SECTION_KINDS[LIBREDWG_SCENE_SECTION_COUNT]
    = { SECTION_DRAWING,
        SECTION_LAYERS,
        SECTION_BLOCKS,
        SECTION_LINES,
        SECTION_ARCS,
        SECTION_CIRCLES,
        SECTION_INSERTS,
        SECTION_POLYLINE_HEADERS,
        SECTION_POLYLINE_VERTICES,
        SECTION_ELLIPSES,
        SECTION_SPLINE_HEADERS,
        SECTION_SPLINE_KNOTS,
        SECTION_SPLINE_WEIGHTS,
        SECTION_SPLINE_CONTROL_POINTS,
        SECTION_SPLINE_FIT_POINTS,
        SECTION_GPU_LINE_BATCHES,
        SECTION_GPU_LINE_VERTICES };

static const uint32_t SECTION_RECORD_SIZES[LIBREDWG_SCENE_SECTION_COUNT]
    = { DRAWING_RECORD_SIZE,
        LAYER_RECORD_SIZE,
        BLOCK_RECORD_SIZE,
        LINE_RECORD_SIZE,
        ARC_RECORD_SIZE,
        CIRCLE_RECORD_SIZE,
        INSERT_RECORD_SIZE,
        POLYLINE_HEADER_RECORD_SIZE,
        POLYLINE_VERTEX_RECORD_SIZE,
        ELLIPSE_RECORD_SIZE,
        SPLINE_HEADER_RECORD_SIZE,
        SPLINE_SCALAR_RECORD_SIZE,
        SPLINE_SCALAR_RECORD_SIZE,
        SPLINE_POINT_RECORD_SIZE,
        SPLINE_POINT_RECORD_SIZE,
        GPU_LINE_BATCH_RECORD_SIZE,
        GPU_LINE_VERTEX_RECORD_SIZE };

static const char *const SECTION_NAMES[LIBREDWG_SCENE_SECTION_COUNT]
    = { "drawing",
        "layers",
        "blocks",
        "lines",
        "arcs",
        "circles",
        "inserts",
        "polyline_headers",
        "polyline_vertices",
        "ellipses",
        "spline_headers",
        "spline_knots",
        "spline_weights",
        "spline_control_points",
        "spline_fit_points",
        "gpu_line_batches",
        "gpu_line_vertices" };

static void
set_error (CacheWriter *writer, const char *message)
{
  if (writer->failed)
    return;
  writer->failed = 1;
  if (writer->error && writer->error_size)
    {
      (void)snprintf (writer->error, writer->error_size, "%s", message);
    }
}

static int
write_bytes (CacheWriter *writer, const void *value, size_t size)
{
  if (writer->failed)
    return 0;
  if (size && fwrite (value, 1, size, writer->file) != size)
    {
      set_error (writer, "cannot write scene cache");
      return 0;
    }
  return 1;
}

static int
write_u16 (CacheWriter *writer, uint16_t value)
{
  uint8_t bytes[2] = { (uint8_t)value, (uint8_t)(value >> 8) };
  return write_bytes (writer, bytes, sizeof (bytes));
}

static int
write_i16 (CacheWriter *writer, int16_t value)
{
  return write_u16 (writer, (uint16_t)value);
}

static int
write_u32 (CacheWriter *writer, uint32_t value)
{
  uint8_t bytes[4] = { (uint8_t)value, (uint8_t)(value >> 8),
                       (uint8_t)(value >> 16), (uint8_t)(value >> 24) };
  return write_bytes (writer, bytes, sizeof (bytes));
}

static int
write_i32 (CacheWriter *writer, int32_t value)
{
  return write_u32 (writer, (uint32_t)value);
}

static int
write_u64 (CacheWriter *writer, uint64_t value)
{
  uint8_t bytes[8] = { (uint8_t)value,
                       (uint8_t)(value >> 8),
                       (uint8_t)(value >> 16),
                       (uint8_t)(value >> 24),
                       (uint8_t)(value >> 32),
                       (uint8_t)(value >> 40),
                       (uint8_t)(value >> 48),
                       (uint8_t)(value >> 56) };
  return write_bytes (writer, bytes, sizeof (bytes));
}

static int
write_f32 (CacheWriter *writer, float value)
{
  uint32_t encoded;
  memcpy (&encoded, &value, sizeof (encoded));
  return write_u32 (writer, encoded);
}

static int
write_f64 (CacheWriter *writer, double value)
{
  uint64_t encoded;
  memcpy (&encoded, &value, sizeof (encoded));
  return write_u64 (writer, encoded);
}

static int
write_vec3 (CacheWriter *writer, const double value[3])
{
  return write_f64 (writer, value[0]) && write_f64 (writer, value[1])
         && write_f64 (writer, value[2]);
}

static uint64_t
align_up (uint64_t value, uint64_t alignment)
{
  return (value + alignment - 1u) & ~(alignment - 1u);
}

static int
position (CacheWriter *writer, uint64_t *value)
{
  off_t result;
  if (writer->failed)
    return 0;
  result = ftello (writer->file);
  if (result < 0)
    {
      set_error (writer, "cannot read scene-cache position");
      return 0;
    }
  *value = (uint64_t)result;
  return 1;
}

static int
seek_to (CacheWriter *writer, uint64_t value)
{
  if (writer->failed)
    return 0;
  if (value > (uint64_t)INT64_MAX
      || fseeko (writer->file, (off_t)value, SEEK_SET) != 0)
    {
      set_error (writer, "cannot seek in scene cache");
      return 0;
    }
  return 1;
}

static int
align_writer (CacheWriter *writer, uint64_t *offset)
{
  uint64_t current;
  uint64_t aligned;
  static const uint8_t zeros[8] = { 0 };
  if (!position (writer, &current))
    return 0;
  aligned = align_up (current, 8);
  if (aligned > current
      && !write_bytes (writer, zeros, (size_t)(aligned - current)))
    return 0;
  *offset = aligned;
  return 1;
}

static int
finish_fixed_section (CacheWriter *writer, SectionEntry *entry,
                      uint32_t kind, uint32_t record_size, const char *name,
                      uint64_t offset, uint64_t count)
{
  uint64_t end;
  uint64_t expected;
  if (!position (writer, &end))
    return 0;
  if (count > UINT64_MAX / record_size)
    {
      set_error (writer, "scene-cache section size overflow");
      return 0;
    }
  expected = count * record_size;
  if (end < offset || end - offset != expected)
    {
      set_error (writer, "scene-cache fixed section size mismatch");
      return 0;
    }
  entry->kind = kind;
  entry->record_size = record_size;
  entry->offset = offset;
  entry->byte_length = expected;
  entry->record_count = count;
  entry->flags = 0;
  entry->name = name;
  return 1;
}

static int
finish_variable_section (CacheWriter *writer, SectionEntry *entry,
                         uint32_t kind, uint32_t record_size,
                         const char *name, uint64_t offset, uint64_t count,
                         uint32_t flags)
{
  uint64_t end;
  if (!position (writer, &end) || end < offset)
    return 0;
  entry->kind = kind;
  entry->record_size = record_size;
  entry->offset = offset;
  entry->byte_length = end - offset;
  entry->record_count = count;
  entry->flags = flags;
  entry->name = name;
  return 1;
}

static uint64_t
reference_handle (const Dwg_Object_Ref *reference)
{
  if (!reference)
    return 0;
  if (reference->absolute_ref)
    return (uint64_t)reference->absolute_ref;
  if (reference->obj)
    return (uint64_t)reference->obj->handle.value;
  return (uint64_t)reference->handleref.value;
}

static char *
copy_utf8_field (void *value, const char *type, const char *field,
                 const char *fallback)
{
  char *text = NULL;
  char *copy;
  size_t length;
  int is_new = 0;

  if (value && dwg_dynapi_entity_utf8text (value, type, field, &text, &is_new,
                                           NULL)
      && text)
    fallback = text;
  length = strlen (fallback);
  if (length > MAX_CACHE_STRING_BYTES)
    {
      if (is_new)
        free (text);
      return NULL;
    }
  copy = (char *)malloc (length + 1);
  if (copy)
    memcpy (copy, fallback, length + 1);
  if (is_new)
    free (text);
  return copy;
}

static char *
copy_linetype_name (const Dwg_Object_Ref *reference)
{
  Dwg_Object *object = reference ? reference->obj : NULL;
  if (!object || object->fixedtype != DWG_TYPE_LTYPE || !object->tio.object
      || !object->tio.object->tio.LTYPE)
    return copy_utf8_field (NULL, "", "", "Continuous");
  return copy_utf8_field (object->tio.object->tio.LTYPE, "LTYPE", "name",
                          "Continuous");
}

static int
handle_index_compare (const void *left, const void *right)
{
  const HandleIndex *a = (const HandleIndex *)left;
  const HandleIndex *b = (const HandleIndex *)right;
  if (a->handle < b->handle)
    return -1;
  if (a->handle > b->handle)
    return 1;
  return a->index < b->index ? -1 : a->index > b->index;
}

static uint32_t
find_handle_index (const HandleIndex *indices, size_t count, uint64_t handle)
{
  size_t left = 0;
  size_t right = count;
  while (left < right)
    {
      size_t middle = left + (right - left) / 2;
      if (indices[middle].handle < handle)
        left = middle + 1;
      else
        right = middle;
    }
  if (left < count && indices[left].handle == handle)
    return indices[left].index;
  return UINT32_MAX;
}

static void
free_tables (CacheTables *tables)
{
  size_t i;
  for (i = 0; i < tables->layer_count; i++)
    {
      free (tables->layers[i].name);
      free (tables->layers[i].linetype);
    }
  for (i = 0; i < tables->block_count; i++)
    free (tables->blocks[i].name);
  free (tables->layers);
  free (tables->layer_indices);
  free (tables->blocks);
  free (tables->block_indices);
  memset (tables, 0, sizeof (*tables));
}

static int
build_tables (Dwg_Data *dwg, CacheTables *tables)
{
  size_t layer_count = 0;
  size_t block_count = 0;
  size_t layer_index = 0;
  size_t block_index = 0;
  size_t i;

  memset (tables, 0, sizeof (*tables));
  tables->model_handle
      = reference_handle (dwg->header_vars.BLOCK_RECORD_MSPACE);
  tables->paper_handle
      = reference_handle (dwg->header_vars.BLOCK_RECORD_PSPACE);

  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      if (dwg->object[i].fixedtype == DWG_TYPE_LAYER)
        layer_count++;
      else if (dwg->object[i].fixedtype == DWG_TYPE_BLOCK_HEADER)
        block_count++;
    }
  if (layer_count > UINT32_MAX || block_count > UINT32_MAX)
    return 0;
  tables->layers
      = layer_count ? (LayerEntry *)calloc (layer_count, sizeof (LayerEntry))
                    : NULL;
  tables->layer_indices
      = layer_count
            ? (HandleIndex *)malloc (layer_count * sizeof (HandleIndex))
            : NULL;
  tables->blocks
      = block_count ? (BlockEntry *)calloc (block_count, sizeof (BlockEntry))
                    : NULL;
  tables->block_indices
      = block_count
            ? (HandleIndex *)malloc (block_count * sizeof (HandleIndex))
            : NULL;
  if ((layer_count && (!tables->layers || !tables->layer_indices))
      || (block_count && (!tables->blocks || !tables->block_indices)))
    {
      free_tables (tables);
      return 0;
    }
  /*
   * Keep the allocated lengths visible to cleanup while rows are populated.
   * calloc leaves any not-yet-populated string pointers safe to free.
   */
  tables->layer_count = layer_count;
  tables->block_count = block_count;

  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_LAYER && object->tio.object
          && object->tio.object->tio.LAYER)
        {
          LayerEntry *entry = &tables->layers[layer_index];
          entry->object = object;
          entry->handle = (uint64_t)object->handle.value;
          entry->name
              = copy_utf8_field (object->tio.object->tio.LAYER, "LAYER",
                                 "name", "0");
          entry->linetype = copy_linetype_name (
              object->tio.object->tio.LAYER->ltype);
          if (!entry->name || !entry->linetype)
            {
              free_tables (tables);
              return 0;
            }
          tables->layer_indices[layer_index].handle = entry->handle;
          tables->layer_indices[layer_index].index = (uint32_t)layer_index;
          layer_index++;
        }
      else if (object->fixedtype == DWG_TYPE_BLOCK_HEADER
               && object->tio.object
               && object->tio.object->tio.BLOCK_HEADER)
        {
          BlockEntry *entry = &tables->blocks[block_index];
          entry->object = object;
          entry->handle = (uint64_t)object->handle.value;
          entry->name
              = copy_utf8_field (object->tio.object->tio.BLOCK_HEADER,
                                 "BLOCK_HEADER", "name", "");
          if (!entry->name)
            {
              free_tables (tables);
              return 0;
            }
          entry->is_model
              = entry->handle != 0 && entry->handle == tables->model_handle;
          entry->is_paper
              = entry->handle != 0 && entry->handle == tables->paper_handle;
          tables->block_indices[block_index].handle = entry->handle;
          tables->block_indices[block_index].index = (uint32_t)block_index;
          block_index++;
        }
    }
  tables->layer_count = layer_index;
  tables->block_count = block_index;
  qsort (tables->layer_indices, tables->layer_count, sizeof (HandleIndex),
         handle_index_compare);
  qsort (tables->block_indices, tables->block_count, sizeof (HandleIndex),
         handle_index_compare);
  return 1;
}

static uint32_t
encode_color (const Dwg_Color *color)
{
  uint32_t rgb;
  if (!color || color->index == 256
      || color->method == DWG_COLOR_METHOD_BYLAYER)
    return 0;
  if (color->index == 0 || color->method == DWG_COLOR_METHOD_BYBLOCK)
    return 1u << 30;
  rgb = (uint32_t)color->rgb & 0x00ffffffu;
  if (color->method == DWG_COLOR_METHOD_TRUECOLOR && rgb)
    return (3u << 30) | rgb;
  return (2u << 30) | ((uint32_t)color->index & 0xffu);
}

static uint64_t
entity_owner_handle (const Dwg_Object_Entity *entity,
                     const CacheTables *tables)
{
  uint64_t handle;
  if (!entity)
    return 0;
  handle = reference_handle (entity->ownerhandle);
  if (handle)
    return handle;
  if (entity->entmode == 2)
    return tables->model_handle;
  if (entity->entmode == 1)
    return tables->paper_handle;
  return 0;
}

static uint32_t
entity_layer_index (const Dwg_Object_Entity *entity,
                    const CacheTables *tables)
{
  return find_handle_index (tables->layer_indices, tables->layer_count,
                            reference_handle (entity ? entity->layer : NULL));
}

static int
write_common (CacheWriter *writer, const Dwg_Object *object,
              const CacheTables *tables)
{
  const Dwg_Object_Entity *entity = object->tio.entity;
  int line_weight = entity ? dxf_cvt_lweight (entity->linewt) : -1;
  uint16_t flags = entity && entity->invisible ? 1u : 0u;
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  return write_u64 (writer, (uint64_t)object->handle.value)
         && write_u64 (writer, entity_owner_handle (entity, tables))
         && write_u32 (writer, entity_layer_index (entity, tables))
         && write_u32 (writer,
                       encode_color (entity ? &entity->color : NULL))
         && write_i16 (writer, (int16_t)line_weight)
         && write_u16 (writer, flags) && write_u32 (writer, 0);
}

static int
is_logical_entity (const Dwg_Object *object)
{
  if (object->supertype != DWG_SUPERTYPE_ENTITY)
    return 0;
  switch (object->fixedtype)
    {
    case DWG_TYPE_BLOCK:
    case DWG_TYPE_ENDBLK:
    case DWG_TYPE_SEQEND:
    case DWG_TYPE_VERTEX_2D:
    case DWG_TYPE_VERTEX_3D:
    case DWG_TYPE_VERTEX_MESH:
    case DWG_TYPE_VERTEX_PFACE:
    case DWG_TYPE_VERTEX_PFACE_FACE:
    case DWG_TYPE_ATTRIB:
      return 0;
    default:
      return 1;
    }
}

static LibreDwgPrimitiveCounts
count_primitives (const Dwg_Data *dwg)
{
  LibreDwgPrimitiveCounts counts;
  size_t i;
  memset (&counts, 0, sizeof (counts));
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      if (!is_logical_entity (object))
        continue;
      counts.total_entities++;
      switch (object->fixedtype)
        {
        case DWG_TYPE_LINE:
          counts.lines++;
          break;
        case DWG_TYPE_ARC:
          counts.arcs++;
          break;
        case DWG_TYPE_CIRCLE:
          counts.circles++;
          break;
        case DWG_TYPE_INSERT:
        case DWG_TYPE_MINSERT:
          counts.inserts++;
          break;
        case DWG_TYPE_ELLIPSE:
          counts.ellipses++;
          break;
        default:
          break;
        }
    }
  counts.serialized_entities = counts.lines + counts.arcs + counts.circles
                               + counts.inserts + counts.ellipses;
  counts.deferred_entities
      = counts.total_entities - counts.serialized_entities;
  return counts;
}

static int
write_drawing_section (CacheWriter *writer, Dwg_Data *dwg,
                       const LibreDwgPrimitiveCounts *counts,
                       uint32_t source_version, SectionEntry *entry)
{
  uint64_t offset;
  double min[3];
  double max[3];
  size_t axis;
  min[0] = dwg_model_x_min (dwg);
  min[1] = dwg_model_y_min (dwg);
  min[2] = dwg_model_z_min (dwg);
  max[0] = dwg_model_x_max (dwg);
  max[1] = dwg_model_y_max (dwg);
  max[2] = dwg_model_z_max (dwg);
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (min[axis]) || !isfinite (max[axis])
          || min[axis] > max[axis])
        {
          memset (min, 0, sizeof (min));
          memset (max, 0, sizeof (max));
          break;
        }
    }
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, source_version)
      || !write_u32 (writer, (uint32_t)dwg->header.is_maint)
      || !write_i32 (writer, (int32_t)dwg->header_vars.INSUNITS)
      || !write_u32 (writer, 0)
      || !write_u64 (writer, counts->total_entities)
      || !write_u64 (writer, counts->serialized_entities)
      || !write_vec3 (writer, min) || !write_vec3 (writer, max))
    return 0;
  return finish_fixed_section (writer, entry, SECTION_DRAWING,
                               DRAWING_RECORD_SIZE, "drawing", offset, 1);
}

static int
checked_string_layout (uint64_t *cursor, const char *value,
                       uint32_t *offset, uint32_t *length)
{
  size_t string_length = strlen (value);
  if (*cursor > UINT32_MAX || string_length > UINT32_MAX
      || string_length > MAX_CACHE_STRING_BYTES
      || *cursor + string_length > UINT32_MAX)
    return 0;
  *offset = (uint32_t)*cursor;
  *length = (uint32_t)string_length;
  *cursor += string_length;
  return 1;
}

static int
write_layer_section (CacheWriter *writer, const CacheTables *tables,
                     SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint32_t *references;
  size_t i;
  if (tables->layer_count > (SIZE_MAX / (4 * sizeof (uint32_t))))
    {
      set_error (writer, "too many layers for scene cache");
      return 0;
    }
  references
      = tables->layer_count
            ? (uint32_t *)malloc (tables->layer_count * 4 * sizeof (uint32_t))
            : NULL;
  if (tables->layer_count && !references)
    {
      set_error (writer, "out of memory while writing layer table");
      return 0;
    }
  for (i = 0; i < tables->layer_count; i++)
    {
      if (!checked_string_layout (&string_cursor, tables->layers[i].name,
                                  &references[i * 4], &references[i * 4 + 1])
          || !checked_string_layout (
              &string_cursor, tables->layers[i].linetype,
              &references[i * 4 + 2], &references[i * 4 + 3]))
        {
          free (references);
          set_error (writer, "layer string table exceeds its limits");
          return 0;
        }
    }
  string_offset = STRING_TABLE_HEADER_SIZE
                  + (uint64_t)tables->layer_count * LAYER_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)tables->layer_count)
      || !write_u32 (writer, LAYER_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }
  for (i = 0; i < tables->layer_count; i++)
    {
      Dwg_Object_LAYER *layer
          = tables->layers[i].object->tio.object->tio.LAYER;
      uint32_t flags = 0;
      int line_weight = dxf_cvt_lweight (layer->linewt);
      if (layer->off)
        flags |= 1u;
      if (layer->frozen)
        flags |= 1u << 1;
      if (layer->locked)
        flags |= 1u << 2;
      if (layer->plotflag)
        flags |= 1u << 3;
      if (layer->is_xref_dep)
        flags |= 1u << 4;
      if (!write_u64 (writer, tables->layers[i].handle)
          || !write_u32 (writer, references[i * 4])
          || !write_u32 (writer, references[i * 4 + 1])
          || !write_u32 (writer, references[i * 4 + 2])
          || !write_u32 (writer, references[i * 4 + 3])
          || !write_u32 (writer, encode_color (&layer->color))
          || !write_u32 (writer, flags)
          || !write_i32 (writer, (int32_t)line_weight)
          || !write_u32 (writer, 0))
        {
          free (references);
          return 0;
        }
    }
  for (i = 0; i < tables->layer_count; i++)
    {
      if (!write_bytes (writer, tables->layers[i].name,
                        strlen (tables->layers[i].name))
          || !write_bytes (writer, tables->layers[i].linetype,
                           strlen (tables->layers[i].linetype)))
        {
          free (references);
          return 0;
        }
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_LAYERS, LAYER_RECORD_SIZE, "layers", offset,
      (uint64_t)tables->layer_count, SECTION_FLAG_STRING_TABLE);
}

static int
write_block_section (CacheWriter *writer, const CacheTables *tables,
                     SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint32_t *references;
  size_t i;
  if (tables->block_count > SIZE_MAX / (2 * sizeof (uint32_t)))
    {
      set_error (writer, "too many blocks for scene cache");
      return 0;
    }
  references
      = tables->block_count
            ? (uint32_t *)malloc (tables->block_count * 2 * sizeof (uint32_t))
            : NULL;
  if (tables->block_count && !references)
    {
      set_error (writer, "out of memory while writing block table");
      return 0;
    }
  for (i = 0; i < tables->block_count; i++)
    {
      if (!checked_string_layout (&string_cursor, tables->blocks[i].name,
                                  &references[i * 2], &references[i * 2 + 1]))
        {
          free (references);
          set_error (writer, "block string table exceeds its limits");
          return 0;
        }
    }
  string_offset = STRING_TABLE_HEADER_SIZE
                  + (uint64_t)tables->block_count * BLOCK_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)tables->block_count)
      || !write_u32 (writer, BLOCK_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }
  for (i = 0; i < tables->block_count; i++)
    {
      Dwg_Object_BLOCK_HEADER *block
          = tables->blocks[i].object->tio.object->tio.BLOCK_HEADER;
      uint32_t flags = 0;
      double base_point[3]
          = { block->base_pt.x, block->base_pt.y, block->base_pt.z };
      if (block->anonymous)
        flags |= 1u;
      if (block->hasattrs)
        flags |= 1u << 1;
      if (block->blkisxref)
        flags |= 1u << 2;
      if (block->xrefoverlaid)
        flags |= 1u << 3;
      if (block->xref_pname && block->xref_pname[0])
        flags |= 1u << 4;
      if (block->explodable)
        flags |= 1u << 5;
      if (block->block_scaling == 0)
        flags |= 1u << 6;
      if (!write_u64 (writer, tables->blocks[i].handle)
          || !write_u32 (writer, references[i * 2])
          || !write_u32 (writer, references[i * 2 + 1])
          || !write_u32 (writer, (uint32_t)block->num_owned)
          || !write_u32 (writer, (uint32_t)block->num_inserts)
          || !write_u32 (writer, flags)
          || !write_i32 (writer, (int32_t)block->insert_units)
          || !write_vec3 (writer, base_point) || !write_u64 (writer, 0))
        {
          free (references);
          return 0;
        }
    }
  for (i = 0; i < tables->block_count; i++)
    {
      if (!write_bytes (writer, tables->blocks[i].name,
                        strlen (tables->blocks[i].name)))
        {
          free (references);
          return 0;
        }
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_BLOCKS, BLOCK_RECORD_SIZE, "blocks", offset,
      (uint64_t)tables->block_count, SECTION_FLAG_STRING_TABLE);
}

static int
write_line_section (CacheWriter *writer, const Dwg_Data *dwg,
                    const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_LINE *line;
      double start[3];
      double end[3];
      if (object->fixedtype != DWG_TYPE_LINE || !object->tio.entity
          || !(line = object->tio.entity->tio.LINE))
        continue;
      start[0] = line->start.x;
      start[1] = line->start.y;
      start[2] = line->start.z;
      end[0] = line->end.x;
      end[1] = line->end.y;
      end[2] = line->end.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, start) || !write_vec3 (writer, end))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_LINES,
                               LINE_RECORD_SIZE, "lines", offset, count);
}

static int
write_arc_section (CacheWriter *writer, const Dwg_Data *dwg,
                   const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_ARC *arc;
      double center[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_ARC || !object->tio.entity
          || !(arc = object->tio.entity->tio.ARC))
        continue;
      center[0] = arc->center.x;
      center[1] = arc->center.y;
      center[2] = arc->center.z;
      normal[0] = arc->extrusion.x;
      normal[1] = arc->extrusion.y;
      normal[2] = arc->extrusion.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, center)
          || !write_f64 (writer, arc->radius)
          || !write_f64 (writer, arc->start_angle)
          || !write_f64 (writer, arc->end_angle)
          || !write_f64 (writer, arc->thickness)
          || !write_vec3 (writer, normal))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_ARCS, ARC_RECORD_SIZE,
                               "arcs", offset, count);
}

static int
write_circle_section (CacheWriter *writer, const Dwg_Data *dwg,
                      const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_CIRCLE *circle;
      double center[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_CIRCLE || !object->tio.entity
          || !(circle = object->tio.entity->tio.CIRCLE))
        continue;
      center[0] = circle->center.x;
      center[1] = circle->center.y;
      center[2] = circle->center.z;
      normal[0] = circle->extrusion.x;
      normal[1] = circle->extrusion.y;
      normal[2] = circle->extrusion.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, center)
          || !write_f64 (writer, circle->radius)
          || !write_f64 (writer, circle->thickness)
          || !write_vec3 (writer, normal))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_CIRCLES,
                               CIRCLE_RECORD_SIZE, "circles", offset, count);
}

static int
write_insert_record (CacheWriter *writer, const Dwg_Object *object,
                     const CacheTables *tables, const double insert_point[3],
                     const double scale[3], double rotation,
                     const double normal[3], uint64_t target_handle,
                     uint16_t columns, uint16_t rows, double column_spacing,
                     double row_spacing)
{
  uint32_t block_index
      = find_handle_index (tables->block_indices, tables->block_count,
                           target_handle);
  return write_common (writer, object, tables)
         && write_u32 (writer, block_index) && write_u16 (writer, columns)
         && write_u16 (writer, rows) && write_vec3 (writer, insert_point)
         && write_vec3 (writer, scale) && write_f64 (writer, rotation)
         && write_vec3 (writer, normal)
         && write_f64 (writer, column_spacing)
         && write_f64 (writer, row_spacing);
}

static uint16_t
bounded_u16_or_one (uint64_t value)
{
  if (value == 0)
    return 1;
  return value > UINT16_MAX ? UINT16_MAX : (uint16_t)value;
}

static int
write_insert_section (CacheWriter *writer, const Dwg_Data *dwg,
                      const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      double insert_point[3];
      double scale[3];
      double normal[3];
      if (!object->tio.entity)
        continue;
      if (object->fixedtype == DWG_TYPE_INSERT
          && object->tio.entity->tio.INSERT)
        {
          Dwg_Entity_INSERT *insert = object->tio.entity->tio.INSERT;
          insert_point[0] = insert->ins_pt.x;
          insert_point[1] = insert->ins_pt.y;
          insert_point[2] = insert->ins_pt.z;
          scale[0] = insert->scale.x;
          scale[1] = insert->scale.y;
          scale[2] = insert->scale.z;
          normal[0] = insert->extrusion.x;
          normal[1] = insert->extrusion.y;
          normal[2] = insert->extrusion.z;
          if (!write_insert_record (
                  writer, object, tables, insert_point, scale,
                  insert->rotation, normal,
                  reference_handle (insert->block_header),
                  bounded_u16_or_one (insert->num_cols),
                  bounded_u16_or_one (insert->num_rows),
                  insert->col_spacing, insert->row_spacing))
            return 0;
          count++;
        }
      else if (object->fixedtype == DWG_TYPE_MINSERT
               && object->tio.entity->tio.MINSERT)
        {
          Dwg_Entity_MINSERT *insert = object->tio.entity->tio.MINSERT;
          insert_point[0] = insert->ins_pt.x;
          insert_point[1] = insert->ins_pt.y;
          insert_point[2] = insert->ins_pt.z;
          scale[0] = insert->scale.x;
          scale[1] = insert->scale.y;
          scale[2] = insert->scale.z;
          normal[0] = insert->extrusion.x;
          normal[1] = insert->extrusion.y;
          normal[2] = insert->extrusion.z;
          if (!write_insert_record (
                  writer, object, tables, insert_point, scale,
                  insert->rotation, normal,
                  reference_handle (insert->block_header),
                  bounded_u16_or_one (insert->num_cols),
                  bounded_u16_or_one (insert->num_rows),
                  insert->col_spacing, insert->row_spacing))
            return 0;
          count++;
        }
    }
  return finish_fixed_section (writer, entry, SECTION_INSERTS,
                               INSERT_RECORD_SIZE, "inserts", offset, count);
}

static int
write_ellipse_section (CacheWriter *writer, const Dwg_Data *dwg,
                       const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_ELLIPSE *ellipse;
      double center[3];
      double major_axis[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_ELLIPSE || !object->tio.entity
          || !(ellipse = object->tio.entity->tio.ELLIPSE))
        continue;
      center[0] = ellipse->center.x;
      center[1] = ellipse->center.y;
      center[2] = ellipse->center.z;
      major_axis[0] = ellipse->sm_axis.x;
      major_axis[1] = ellipse->sm_axis.y;
      major_axis[2] = ellipse->sm_axis.z;
      normal[0] = ellipse->extrusion.x;
      normal[1] = ellipse->extrusion.y;
      normal[2] = ellipse->extrusion.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, center)
          || !write_vec3 (writer, major_axis)
          || !write_vec3 (writer, normal)
          || !write_f64 (writer, ellipse->axis_ratio)
          || !write_f64 (writer, ellipse->start_angle)
          || !write_f64 (writer, ellipse->end_angle))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_ELLIPSES,
                               ELLIPSE_RECORD_SIZE, "ellipses", offset,
                               count);
}

static int
write_empty_section (CacheWriter *writer, SectionEntry *entry, uint32_t kind,
                     uint32_t record_size, const char *name)
{
  uint64_t offset;
  if (!align_writer (writer, &offset))
    return 0;
  return finish_fixed_section (writer, entry, kind, record_size, name,
                               offset, 0);
}

static uint32_t
entity_group (const Dwg_Object_Entity *entity, const CacheTables *tables)
{
  uint64_t owner = entity_owner_handle (entity, tables);
  uint32_t index
      = find_handle_index (tables->block_indices, tables->block_count, owner);
  if (index != UINT32_MAX)
    {
      if (tables->blocks[index].is_model)
        return UINT32_MAX;
      if (tables->blocks[index].is_paper)
        return UINT32_MAX - 1u;
      return index;
    }
  if (entity && entity->entmode == 2)
    return UINT32_MAX;
  return UINT32_MAX - 1u;
}

static int
line_segment_from_object (const Dwg_Object *object,
                          const CacheTables *tables, LineSegment *segment)
{
  Dwg_Entity_LINE *line;
  Dwg_Object_Entity *entity;
  int line_weight;
  size_t axis;
  if (object->fixedtype != DWG_TYPE_LINE || !object->tio.entity
      || !(line = object->tio.entity->tio.LINE))
    return 0;
  entity = object->tio.entity;
  segment->group = entity_group (entity, tables);
  if (segment->group == UINT32_MAX - 1u)
    return 0;
  segment->start[0] = line->start.x;
  segment->start[1] = line->start.y;
  segment->start[2] = line->start.z;
  segment->end[0] = line->end.x;
  segment->end[1] = line->end.y;
  segment->end[2] = line->end.z;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (segment->start[axis])
          || !isfinite (segment->end[axis]))
        return -1;
    }
  line_weight = dxf_cvt_lweight (entity->linewt);
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  segment->handle = (uint64_t)object->handle.value;
  segment->layer_index = entity_layer_index (entity, tables);
  segment->color = encode_color (&entity->color);
  segment->line_weight = (int16_t)line_weight;
  segment->flags = entity->invisible ? 1u : 0u;
  return 1;
}

static int
group_rank_compare (const void *left, const void *right)
{
  const GroupRank *a = (const GroupRank *)left;
  const GroupRank *b = (const GroupRank *)right;
  if (a->value > b->value)
    return -1;
  if (a->value < b->value)
    return 1;
  return a->index < b->index ? -1 : a->index > b->index;
}

static int
initialize_overview_plan (const CacheTables *tables, OverviewPlan *plan)
{
  memset (plan, 0, sizeof (*plan));
  if (tables->block_count == SIZE_MAX)
    return 0;
  plan->group_count = tables->block_count + 1;
  if (plan->group_count > SIZE_MAX / sizeof (OverviewGroup))
    return 0;
  plan->groups
      = (OverviewGroup *)calloc (plan->group_count, sizeof (OverviewGroup));
  return plan->groups != NULL;
}

static void
free_overview_plan (OverviewPlan *plan)
{
  free (plan->groups);
  memset (plan, 0, sizeof (*plan));
}

static size_t
overview_group_index (const LineSegment *segment,
                      const OverviewPlan *plan)
{
  return segment->group == UINT32_MAX ? plan->group_count - 1
                                     : (size_t)segment->group;
}

static int
finalize_overview_quotas (OverviewPlan *plan)
{
  GroupRank *ranks = NULL;
  uint64_t total = 0;
  uint64_t nonempty = 0;
  uint64_t remaining;
  uint64_t capacity_total;
  uint64_t allocated = 0;
  size_t rank_count = 0;
  size_t i;

  for (i = 0; i < plan->group_count; i++)
    {
      if (UINT64_MAX - total < plan->groups[i].count)
        return 0;
      total += plan->groups[i].count;
      if (plan->groups[i].count)
        nonempty++;
    }
  if (total <= SCENE_OVERVIEW_SEGMENTS)
    {
      for (i = 0; i < plan->group_count; i++)
        plan->groups[i].quota = plan->groups[i].count;
      plan->quota_total = total;
      return 1;
    }

  if (nonempty > SIZE_MAX / sizeof (GroupRank))
    return 0;
  ranks = (GroupRank *)malloc ((size_t)nonempty * sizeof (GroupRank));
  if (!ranks)
    return 0;
  for (i = 0; i < plan->group_count; i++)
    {
      if (!plan->groups[i].count)
        continue;
      ranks[rank_count].value = plan->groups[i].count;
      ranks[rank_count].index = i;
      rank_count++;
    }

  if (nonempty > SCENE_OVERVIEW_SEGMENTS)
    {
      qsort (ranks, rank_count, sizeof (GroupRank), group_rank_compare);
      for (i = 0; i < SCENE_OVERVIEW_SEGMENTS; i++)
        plan->groups[ranks[i].index].quota = 1;
      plan->quota_total = SCENE_OVERVIEW_SEGMENTS;
      free (ranks);
      return 1;
    }

  for (i = 0; i < rank_count; i++)
    plan->groups[ranks[i].index].quota = 1;
  remaining = SCENE_OVERVIEW_SEGMENTS - nonempty;
  capacity_total = total - nonempty;
  for (i = 0; i < rank_count; i++)
    {
      OverviewGroup *group = &plan->groups[ranks[i].index];
      uint64_t capacity = group->count - 1;
      uint64_t product;
      uint64_t extra;
      if (remaining && capacity > UINT64_MAX / remaining)
        {
          free (ranks);
          return 0;
        }
      product = remaining * capacity;
      extra = product / capacity_total;
      group->quota += extra;
      allocated += extra;
      ranks[i].value = product % capacity_total;
    }
  qsort (ranks, rank_count, sizeof (GroupRank), group_rank_compare);
  for (i = 0; i < (size_t)(remaining - allocated); i++)
    plan->groups[ranks[i].index].quota++;
  plan->quota_total = SCENE_OVERVIEW_SEGMENTS;
  free (ranks);
  return 1;
}

static void
reset_overview_plan (OverviewPlan *plan)
{
  size_t i;
  for (i = 0; i < plan->group_count; i++)
    {
      plan->groups[i].seen = 0;
      plan->groups[i].emitted = 0;
    }
}

static uint64_t
overview_sample_index (uint64_t sample, uint64_t count, uint64_t quota)
{
  uint64_t span;
  uint64_t denominator;
  if (quota <= 1)
    return count / 2;
  span = count - 1;
  denominator = quota - 1;
  return (span / denominator) * sample
         + ((span % denominator) * sample) / denominator;
}

static int
overview_select (OverviewPlan *plan, const LineSegment *segment)
{
  size_t index = overview_group_index (segment, plan);
  OverviewGroup *group;
  uint64_t position;
  uint64_t target;
  if (index >= plan->group_count)
    return 0;
  group = &plan->groups[index];
  position = group->seen++;
  if (group->emitted >= group->quota)
    return 0;
  target = overview_sample_index (group->emitted, group->count,
                                  group->quota);
  if (position != target)
    return 0;
  group->emitted++;
  return 1;
}

static int
iterate_line_segments (const Dwg_Data *dwg, const CacheTables *tables,
                       OverviewPlan *overview, LineSegmentConsumer consumer,
                       void *context, uint64_t *selected)
{
  uint64_t emitted = 0;
  size_t i;
  if (overview)
    reset_overview_plan (overview);
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      LineSegment segment;
      int status = line_segment_from_object (&dwg->object[i], tables,
                                             &segment);
      if (status <= 0)
        continue;
      if (!overview || overview_select (overview, &segment))
        {
          if (!consumer (context, &segment))
            return 0;
          emitted++;
        }
    }
  if (selected)
    *selected = emitted;
  if (overview && emitted != overview->quota_total)
    return 0;
  return 1;
}

static void
count_gpu_segments (const Dwg_Data *dwg, const CacheTables *tables,
                    LibreDwgGpuLineSummary *summary, OverviewPlan *overview)
{
  size_t i;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      LineSegment segment;
      int status
          = line_segment_from_object (&dwg->object[i], tables, &segment);
      if (status < 0)
        summary->skipped_non_finite_segments++;
      else if (status > 0)
        {
          size_t index = overview_group_index (&segment, overview);
          if (segment.group == UINT32_MAX)
            summary->model_segments++;
          else
            summary->block_segments++;
          if (index < overview->group_count)
            overview->groups[index].count++;
        }
    }
}

static double
position_error_bound (const double min[3], const double max[3],
                      const double origin[3])
{
  double maximum = 0.0;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      double magnitude = fmax (fabs (min[axis] - origin[axis]),
                               fabs (max[axis] - origin[axis]));
      double error = magnitude * FLT_EPSILON
                     + (fabs (origin[axis]) + magnitude) * DBL_EPSILON
                     + ldexp (1.0, -149);
      maximum = fmax (maximum, error);
    }
  return maximum;
}

static int
write_batch_record (BatchDirectoryBuilder *builder)
{
  CacheWriter *writer = builder->writer;
  LibreDwgGpuLineSummary *summary = builder->summary;
  uint16_t kind;
  uint32_t block_index;
  uint32_t id;
  uint64_t vertex_count;
  uint64_t batch_bytes;
  double origin[3];
  double error;
  float encoded_error;
  size_t axis;
  if (!builder->count)
    return 1;
  if (summary->batches > UINT32_MAX)
    {
      set_error (writer, "too many GPU line batches");
      return 0;
    }
  id = (uint32_t)summary->batches;
  if (builder->current_group == UINT32_MAX)
    {
      kind = builder->separate_overview && builder->lod_level == 0 ? 0u : 1u;
      block_index = UINT32_MAX;
      if (kind == 0)
        summary->model_overview_batches++;
      else
        summary->model_detail_batches++;
    }
  else
    {
      kind = 2u;
      block_index = builder->current_group;
      summary->block_batches++;
      if (builder->lod_level == 0)
        summary->block_overview_batches++;
      else
        summary->block_detail_batches++;
    }
  vertex_count = (uint64_t)builder->count * 2u;
  batch_bytes = vertex_count * GPU_LINE_VERTEX_RECORD_SIZE;
  for (axis = 0; axis < 3; axis++)
    origin[axis] = builder->min[axis] * 0.5 + builder->max[axis] * 0.5;
  error = position_error_bound (builder->min, builder->max, origin);
  encoded_error = (float)error;
  if (!isfinite (encoded_error))
    {
      set_error (writer, "GPU batch coordinates exceed f32 range");
      return 0;
    }
  if ((double)encoded_error < error)
    encoded_error = nextafterf (encoded_error, INFINITY);
  if (!write_u32 (writer, id) || !write_u16 (writer, kind)
      || !write_u16 (writer, builder->lod_level)
      || !write_u32 (writer, 0) || !write_u32 (writer, block_index)
      || !write_u64 (writer, builder->first_vertex)
      || !write_u64 (writer, vertex_count)
      || !write_u32 (writer, builder->count) || !write_u32 (writer, 0)
      || !write_vec3 (writer, origin)
      || !write_vec3 (writer, builder->min)
      || !write_vec3 (writer, builder->max)
      || !write_f32 (writer, encoded_error) || !write_u32 (writer, 0)
      || !write_u64 (writer, 0))
    return 0;
  builder->first_vertex += vertex_count;
  summary->batches++;
  summary->maximum_batch_bytes
      = summary->maximum_batch_bytes > batch_bytes
            ? summary->maximum_batch_bytes
            : batch_bytes;
  summary->maximum_position_error
      = fmax (summary->maximum_position_error, error);
  builder->count = 0;
  builder->has_group = 0;
  return 1;
}

static int
batch_directory_consume (void *context, const LineSegment *segment)
{
  BatchDirectoryBuilder *builder = (BatchDirectoryBuilder *)context;
  size_t axis;
  if (builder->has_group
      && (builder->current_group != segment->group
          || builder->count == GPU_BATCH_SEGMENTS)
      && !write_batch_record (builder))
    return 0;
  if (!builder->has_group)
    {
      builder->current_group = segment->group;
      builder->has_group = 1;
      for (axis = 0; axis < 3; axis++)
        {
          builder->min[axis]
              = fmin (segment->start[axis], segment->end[axis]);
          builder->max[axis]
              = fmax (segment->start[axis], segment->end[axis]);
        }
    }
  else
    {
      for (axis = 0; axis < 3; axis++)
        {
          builder->min[axis]
              = fmin (builder->min[axis],
                      fmin (segment->start[axis], segment->end[axis]));
          builder->max[axis]
              = fmax (builder->max[axis],
                      fmax (segment->start[axis], segment->end[axis]));
        }
    }
  builder->count++;
  return 1;
}

static int
write_batch_pass (CacheWriter *writer, const Dwg_Data *dwg,
                  const CacheTables *tables,
                  LibreDwgGpuLineSummary *summary, OverviewPlan *overview,
                  uint16_t lod_level, int separate_overview,
                  uint64_t *selected)
{
  BatchDirectoryBuilder builder;
  memset (&builder, 0, sizeof (builder));
  builder.writer = writer;
  builder.summary = summary;
  builder.lod_level = lod_level;
  builder.separate_overview = separate_overview;
  builder.first_vertex = summary->vertices;
  if (!iterate_line_segments (dwg, tables, overview,
                              batch_directory_consume, &builder, selected)
      || !write_batch_record (&builder))
    return 0;
  summary->vertices = builder.first_vertex;
  return 1;
}

static int
write_gpu_batch_section (CacheWriter *writer, const Dwg_Data *dwg,
                         const CacheTables *tables,
                         LibreDwgGpuLineSummary *summary,
                         OverviewPlan *overview, SectionEntry *entry,
                         int *separate_overview)
{
  uint64_t offset;
  uint64_t total
      = summary->model_segments + summary->block_segments;
  uint64_t selected = 0;
  uint64_t before_batches;
  if (!align_writer (writer, &offset))
    return 0;
  *separate_overview = total > SCENE_OVERVIEW_SEGMENTS;
  before_batches = summary->batches;
  if (*separate_overview)
    {
      if (!write_batch_pass (writer, dwg, tables, summary, overview,
                             0, 1, &selected))
        return 0;
      summary->overview_segments = selected;
      if (!write_batch_pass (writer, dwg, tables, summary, NULL, 1, 1,
                             NULL))
        return 0;
    }
  else
    {
      summary->overview_segments = total;
      if (!write_batch_pass (writer, dwg, tables, summary, NULL, 0, 0,
                             NULL))
        return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_GPU_LINE_BATCHES, GPU_LINE_BATCH_RECORD_SIZE,
      "gpu_line_batches", offset, summary->batches - before_batches);
}

static int
write_gpu_vertex (CacheWriter *writer, const double point[3],
                  const double origin[3], const LineSegment *segment)
{
  uint32_t style = (uint32_t)(uint16_t)segment->line_weight;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      double relative = point[axis] - origin[axis];
      float encoded = (float)relative;
      if (!isfinite (encoded))
        {
          set_error (writer, "GPU vertex exceeds f32 range");
          return 0;
        }
      if (!write_f32 (writer, encoded))
        return 0;
    }
  if (segment->flags & 1u)
    style |= GPU_STYLE_INVISIBLE;
  return write_u32 (writer, segment->layer_index)
         && write_u32 (writer, segment->color)
         && write_u32 (writer, (uint32_t)segment->handle)
         && write_u32 (writer, (uint32_t)(segment->handle >> 32))
         && write_u32 (writer, style);
}

static int
flush_vertex_batch (VertexBuilder *builder)
{
  double min[3];
  double max[3];
  double origin[3];
  uint32_t i;
  size_t axis;
  if (!builder->count)
    return 1;
  for (axis = 0; axis < 3; axis++)
    {
      min[axis] = fmin (builder->segments[0].start[axis],
                        builder->segments[0].end[axis]);
      max[axis] = fmax (builder->segments[0].start[axis],
                        builder->segments[0].end[axis]);
    }
  for (i = 1; i < builder->count; i++)
    {
      for (axis = 0; axis < 3; axis++)
        {
          min[axis]
              = fmin (min[axis],
                      fmin (builder->segments[i].start[axis],
                            builder->segments[i].end[axis]));
          max[axis]
              = fmax (max[axis],
                      fmax (builder->segments[i].start[axis],
                            builder->segments[i].end[axis]));
        }
    }
  for (axis = 0; axis < 3; axis++)
    origin[axis] = min[axis] * 0.5 + max[axis] * 0.5;
  for (i = 0; i < builder->count; i++)
    {
      if (!write_gpu_vertex (builder->writer, builder->segments[i].start,
                             origin, &builder->segments[i])
          || !write_gpu_vertex (builder->writer, builder->segments[i].end,
                                origin, &builder->segments[i]))
        return 0;
      builder->vertices += 2;
    }
  builder->count = 0;
  builder->has_group = 0;
  return 1;
}

static int
vertex_consume (void *context, const LineSegment *segment)
{
  VertexBuilder *builder = (VertexBuilder *)context;
  if (builder->has_group
      && (builder->current_group != segment->group
          || builder->count == GPU_BATCH_SEGMENTS)
      && !flush_vertex_batch (builder))
    return 0;
  if (!builder->has_group)
    {
      builder->current_group = segment->group;
      builder->has_group = 1;
    }
  builder->segments[builder->count++] = *segment;
  return 1;
}

static int
write_vertex_pass (CacheWriter *writer, const Dwg_Data *dwg,
                   const CacheTables *tables, OverviewPlan *overview,
                   uint64_t *vertices)
{
  VertexBuilder builder;
  memset (&builder, 0, sizeof (builder));
  builder.writer = writer;
  builder.segments
      = (LineSegment *)malloc (GPU_BATCH_SEGMENTS * sizeof (LineSegment));
  if (!builder.segments)
    {
      set_error (writer, "out of memory while writing GPU vertices");
      return 0;
    }
  if (!iterate_line_segments (dwg, tables, overview, vertex_consume,
                              &builder, NULL)
      || !flush_vertex_batch (&builder))
    {
      free (builder.segments);
      return 0;
    }
  *vertices += builder.vertices;
  free (builder.segments);
  return 1;
}

static int
write_gpu_vertex_section (CacheWriter *writer, const Dwg_Data *dwg,
                          const CacheTables *tables,
                          LibreDwgGpuLineSummary *summary,
                          OverviewPlan *overview, SectionEntry *entry,
                          int separate_overview)
{
  uint64_t offset;
  uint64_t vertices = 0;
  uint64_t expected = summary->vertices;
  if (!align_writer (writer, &offset))
    return 0;
  if (separate_overview
      && !write_vertex_pass (writer, dwg, tables, overview, &vertices))
    return 0;
  if (!write_vertex_pass (writer, dwg, tables, NULL, &vertices))
    return 0;
  if (vertices != expected)
    {
      set_error (writer, "GPU batch and vertex counts differ");
      return 0;
    }
  summary->cached_vertex_bytes
      = vertices * GPU_LINE_VERTEX_RECORD_SIZE;
  summary->first_frame_vertex_bytes
      = summary->overview_segments * 2u * GPU_LINE_VERTEX_RECORD_SIZE;
  summary->full_detail_vertex_bytes
      = (summary->model_segments + summary->block_segments) * 2u
        * GPU_LINE_VERTEX_RECORD_SIZE;
  return finish_fixed_section (
      writer, entry, SECTION_GPU_LINE_VERTICES, GPU_LINE_VERTEX_RECORD_SIZE,
      "gpu_line_vertices", offset, vertices);
}

static int
write_header (CacheWriter *writer, uint64_t file_size, uint64_t source_size,
              uint32_t source_version, uint32_t maintenance_version)
{
  if (!seek_to (writer, 0) || !write_bytes (writer, CACHE_MAGIC, 8)
      || !write_u16 (writer, CACHE_VERSION_MAJOR)
      || !write_u16 (writer, CACHE_VERSION_MINOR)
      || !write_u32 (writer, CACHE_HEADER_SIZE)
      || !write_u32 (writer, LIBREDWG_SCENE_SECTION_COUNT)
      || !write_u32 (writer, DIRECTORY_ENTRY_SIZE)
      || !write_u32 (writer, 0) || !write_u32 (writer, 0)
      || !write_u64 (writer, CACHE_HEADER_SIZE)
      || !write_u64 (writer, file_size)
      || !write_u64 (writer, source_size)
      || !write_u32 (writer, source_version)
      || !write_u32 (writer, maintenance_version))
    return 0;
  return 1;
}

static int
write_directory (CacheWriter *writer, const SectionEntry *sections)
{
  size_t i;
  if (!seek_to (writer, CACHE_HEADER_SIZE))
    return 0;
  for (i = 0; i < LIBREDWG_SCENE_SECTION_COUNT; i++)
    {
      if (!write_u32 (writer, sections[i].kind)
          || !write_u32 (writer, sections[i].record_size)
          || !write_u64 (writer, sections[i].offset)
          || !write_u64 (writer, sections[i].byte_length)
          || !write_u64 (writer, sections[i].record_count)
          || !write_u32 (writer, sections[i].flags)
          || !write_u32 (writer, 0))
        return 0;
    }
  return 1;
}

int
libredwg_write_scene_cache (
    Dwg_Data *dwg, const char *output_path, uint64_t source_size,
    uint32_t source_version, LibreDwgSceneCacheReport *report,
    char *error_message, size_t error_message_size)
{
  CacheTables tables;
  CacheWriter writer;
  SectionEntry sections[LIBREDWG_SCENE_SECTION_COUNT];
  LibreDwgPrimitiveCounts counts;
  LibreDwgGpuLineSummary gpu_lines;
  OverviewPlan overview;
  uint64_t body_offset;
  uint64_t file_size;
  int separate_overview;
  int descriptor = -1;
  FILE *file = NULL;
  size_t i;
  int created = 0;
  int success = 0;

  memset (report, 0, sizeof (*report));
  memset (&writer, 0, sizeof (writer));
  memset (sections, 0, sizeof (sections));
  memset (&gpu_lines, 0, sizeof (gpu_lines));
  memset (&overview, 0, sizeof (overview));
  if (error_message && error_message_size)
    error_message[0] = '\0';
  writer.error = error_message;
  writer.error_size = error_message_size;

  if (!build_tables (dwg, &tables))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot prepare bounded scene-cache tables");
      return 0;
    }
  counts = count_primitives (dwg);
  if (!initialize_overview_plan (&tables, &overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot allocate bounded overview plan");
      goto done;
    }
  count_gpu_segments (dwg, &tables, &gpu_lines, &overview);
  if (!finalize_overview_quotas (&overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot allocate bounded overview quotas");
      goto done;
    }

  descriptor = open (output_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (descriptor < 0)
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot create cache destination");
      goto done;
    }
  created = 1;
  file = fdopen (descriptor, "wb");
  if (!file)
    {
      close (descriptor);
      descriptor = -1;
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot open cache destination stream");
      goto done;
    }
  descriptor = -1;
  writer.file = file;
  body_offset = align_up (
      CACHE_HEADER_SIZE
          + (uint64_t)LIBREDWG_SCENE_SECTION_COUNT * DIRECTORY_ENTRY_SIZE,
      8);
  if (!seek_to (&writer, body_offset)
      || !write_drawing_section (&writer, dwg, &counts, source_version,
                                 &sections[0])
      || !write_layer_section (&writer, &tables, &sections[1])
      || !write_block_section (&writer, &tables, &sections[2])
      || !write_line_section (&writer, dwg, &tables, &sections[3])
      || !write_arc_section (&writer, dwg, &tables, &sections[4])
      || !write_circle_section (&writer, dwg, &tables, &sections[5])
      || !write_insert_section (&writer, dwg, &tables, &sections[6])
      || !write_empty_section (&writer, &sections[7],
                               SECTION_POLYLINE_HEADERS,
                               POLYLINE_HEADER_RECORD_SIZE,
                               "polyline_headers")
      || !write_empty_section (&writer, &sections[8],
                               SECTION_POLYLINE_VERTICES,
                               POLYLINE_VERTEX_RECORD_SIZE,
                               "polyline_vertices")
      || !write_ellipse_section (&writer, dwg, &tables, &sections[9])
      || !write_empty_section (&writer, &sections[10],
                               SECTION_SPLINE_HEADERS,
                               SPLINE_HEADER_RECORD_SIZE, "spline_headers")
      || !write_empty_section (&writer, &sections[11],
                               SECTION_SPLINE_KNOTS,
                               SPLINE_SCALAR_RECORD_SIZE, "spline_knots")
      || !write_empty_section (&writer, &sections[12],
                               SECTION_SPLINE_WEIGHTS,
                               SPLINE_SCALAR_RECORD_SIZE, "spline_weights")
      || !write_empty_section (&writer, &sections[13],
                               SECTION_SPLINE_CONTROL_POINTS,
                               SPLINE_POINT_RECORD_SIZE,
                               "spline_control_points")
      || !write_empty_section (&writer, &sections[14],
                               SECTION_SPLINE_FIT_POINTS,
                               SPLINE_POINT_RECORD_SIZE,
                               "spline_fit_points")
      || !write_gpu_batch_section (&writer, dwg, &tables, &gpu_lines,
                                   &overview, &sections[15],
                                   &separate_overview)
      || !write_gpu_vertex_section (&writer, dwg, &tables, &gpu_lines,
                                    &overview, &sections[16],
                                    separate_overview)
      || !position (&writer, &file_size)
      || !write_header (&writer, file_size, source_size, source_version,
                        (uint32_t)dwg->header.is_maint)
      || !write_directory (&writer, sections)
      || fflush (file) != 0)
    {
      if (!writer.failed)
        set_error (&writer, "cannot finalize scene cache");
      goto done;
    }
  if (fclose (file) != 0)
    {
      file = NULL;
      set_error (&writer, "cannot close scene cache");
      goto done;
    }
  file = NULL;
  report->cache_size = file_size;
  report->coverage = counts;
  report->gpu_lines = gpu_lines;
  for (i = 0; i < LIBREDWG_SCENE_SECTION_COUNT; i++)
    {
      if (sections[i].kind != SECTION_KINDS[i]
          || sections[i].record_size != SECTION_RECORD_SIZES[i])
        {
          if (error_message && error_message_size)
            (void)snprintf (error_message, error_message_size,
                            "scene-cache section order is inconsistent");
          goto done;
        }
      report->sections[i].name = SECTION_NAMES[i];
      report->sections[i].records = sections[i].record_count;
      report->sections[i].bytes = sections[i].byte_length;
    }
  success = 1;

done:
  if (file)
    fclose (file);
  if (descriptor >= 0)
    close (descriptor);
  if (!success && created)
    unlink (output_path);
  free_overview_plan (&overview);
  free_tables (&tables);
  return success;
}
