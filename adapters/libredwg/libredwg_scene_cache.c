/*
 * SPDX-License-Identifier: MPL-2.0
 *
 * A bounded-memory Scene Cache v1.10 writer for GNU LibreDWG. Geometry and
 * source text are traversed repeatedly and written directly to the
 * destination; the writer never creates a JSON or whole-drawing in-memory
 * representation. Large detail passes use private temporary files for an
 * external XY Morton sort.
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

#define CACHE_VERSION_MAJOR LIBREDWG_SCENE_CACHE_VERSION_MAJOR
#define CACHE_VERSION_MINOR LIBREDWG_SCENE_CACHE_VERSION_MINOR
#define CACHE_HEADER_SIZE 64u
#define DIRECTORY_ENTRY_SIZE 40u
#define SECTION_FLAG_STRING_TABLE 1u
#define STRING_TABLE_HEADER_SIZE 16u
#define MAX_CACHE_STRING_BYTES (1024u * 1024u)
#define GPU_BATCH_SEGMENTS 8192u
#define SCENE_OVERVIEW_SEGMENTS 65536u
#define SPATIAL_SORT_RUN_SEGMENTS 8192u
#define SPATIAL_MERGE_BUFFER_RECORDS 16u
#define GPU_LINE_VERTEX_RECORD_SIZE 32u
#define GPU_BATCH_FLAG_APPROXIMATED_CURVE 1u
#define GPU_STYLE_INVISIBLE (1u << 16)
#define GPU_STYLE_SOURCE_KIND_SHIFT 17u
#define GPU_STYLE_APPROXIMATED_CURVE (1u << 21)
#define TEXT_FLAG_HAS_ALIGNMENT_POINT 1u
#define TEXT_FLAG_HAS_RECTANGLE_HEIGHT (1u << 1)
#define TEXT_FLAG_ANNOTATIVE (1u << 2)
#define TEXT_FLAG_MULTILINE (1u << 3)
#define TEXT_FLAG_LOCK_POSITION (1u << 4)
#define TEXT_FLAG_REALLY_LOCKED (1u << 5)
#define CURVE_MAX_ANGLE_RADIANS 0.39269908169872415481
#define CURVE_FULL_TURN_RADIANS 6.28318530717958647693
#define CURVE_EPSILON 1.0e-12
#define MAX_CIRCULAR_SEGMENTS 16u
#define SPLINE_SEGMENTS_PER_SPAN 2u
#define MAX_SPLINE_DEGREE 15u
#define MAX_SPLINE_SEGMENTS 256u
#define MAX_HATCH_BOUNDARY_SEGMENTS 65536u
#define MAX_HATCH_FILL_VERTICES 1048576u
#define MAX_HATCH_AUX_RECORDS 1048576u
#define MAX_HATCH_PATTERN_LINES_PER_ENTITY 4096u
#define MAX_HATCH_PATTERN_DASHES_PER_ENTITY 65536u
#define MAX_HATCH_PATTERN_LINES 262144u
#define MAX_HATCH_PATTERN_DASHES 1048576u
#define MAX_WIPEOUT_SOURCE_RECORDS 65536u
#define MAX_WIPEOUT_CLIP_VERTICES 1048576u
#define HATCH_FLAG_SOLID 1u
#define HATCH_FLAG_ASSOCIATIVE (1u << 1)
#define HATCH_FLAG_DOUBLE (1u << 2)
#define HATCH_FLAG_GRADIENT (1u << 3)
#define HATCH_FLAG_SINGLE_COLOR_GRADIENT (1u << 4)
#define HATCH_FLAG_TRUNCATED (1u << 5)
#define HATCH_LOOP_FLAG_APPROXIMATED_CURVE 1u

enum
{
  SECTION_DRAWING = 1,
  SECTION_LAYERS = 2,
  SECTION_BLOCKS = 3,
  SECTION_TEXT_STYLES = 4,
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
  SECTION_TEXT_ENTITIES = 22,
  SECTION_TEXT_COLUMN_HEIGHTS = 23,
  SECTION_GPU_LINE_BATCHES = 30,
  SECTION_GPU_LINE_VERTICES = 31,
  SECTION_HATCH_ENTITIES = 32,
  SECTION_HATCH_LOOPS = 33,
  SECTION_HATCH_VERTICES = 34,
  SECTION_HATCH_GRADIENT_COLORS = 35,
  SECTION_HATCH_SEED_POINTS = 36,
  SECTION_HATCH_PATTERN_LINES = 37,
  SECTION_HATCH_PATTERN_DASHES = 38,
  SECTION_POINT_ENTITIES = 39,
  SECTION_SOLID_ENTITIES = 40,
  SECTION_FACE_ENTITIES = 41,
  SECTION_WIPEOUT_ENTITIES = 42,
  SECTION_WIPEOUT_CLIP_VERTICES = 43
};

enum
{
  DRAWING_RECORD_SIZE = 80,
  LAYER_RECORD_SIZE = 40,
  BLOCK_RECORD_SIZE = 64,
  TEXT_STYLE_RECORD_SIZE = 96,
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
  TEXT_ENTITY_RECORD_SIZE = 336,
  TEXT_COLUMN_HEIGHT_RECORD_SIZE = 8,
  GPU_LINE_BATCH_RECORD_SIZE = 128,
  HATCH_ENTITY_RECORD_SIZE = 192,
  HATCH_LOOP_RECORD_SIZE = 48,
  HATCH_VERTEX_RECORD_SIZE = 24,
  HATCH_GRADIENT_COLOR_RECORD_SIZE = 16,
  HATCH_SEED_POINT_RECORD_SIZE = 16,
  HATCH_PATTERN_LINE_RECORD_SIZE = 72,
  HATCH_PATTERN_DASH_RECORD_SIZE = 8,
  POINT_ENTITY_RECORD_SIZE = 112,
  SOLID_ENTITY_RECORD_SIZE = 168,
  FACE_ENTITY_RECORD_SIZE = 136,
  WIPEOUT_ENTITY_RECORD_SIZE = 168,
  WIPEOUT_CLIP_VERTEX_RECORD_SIZE = 16
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
  Dwg_Object *object;
  uint64_t handle;
  char *name;
  char *font_file;
  char *bigfont_file;
} TextStyleEntry;

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
  TextStyleEntry *text_styles;
  size_t text_style_count;
  HandleIndex *text_style_indices;
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
  const Dwg_Object *object;
  uint16_t kind;
  uint16_t flags;
  Dwg_Object_Ref *style;
  char *value;
  char *tag;
  char *prompt;
  uint64_t linked_handle;
  double insertion_point[3];
  double alignment_point[3];
  double normal[3];
  double x_axis_direction[3];
  double height;
  double width_factor;
  double rotation;
  double oblique_angle;
  double thickness;
  double rectangle_width;
  double rectangle_height;
  double extents_width;
  double extents_height;
  double line_spacing_factor;
  double background_scale;
  uint32_t background_color;
  int32_t background_transparency;
  int32_t background_flags;
  int32_t source_flags;
  int16_t horizontal_alignment;
  int16_t vertical_alignment;
  int16_t attachment;
  int16_t flow_direction;
  int16_t line_spacing_style;
  int16_t generation_flags;
  int16_t field_length;
  int16_t mtext_type;
  int32_t line_count;
  int32_t column_type;
  int32_t column_count;
  uint32_t column_flags;
  double column_width;
  double column_gutter;
  const double *column_heights;
  uint64_t column_height_count;
} TextSource;

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
  uint8_t source_kind;
  uint8_t approximated_curve;
} LineSegment;

typedef int (*LineSegmentConsumer) (void *context,
                                    const LineSegment *segment);

typedef struct
{
  double position[3];
  double bulge;
  double start_width;
  double end_width;
  double curve_tangent;
  uint32_t flags;
  int32_t id;
} PolylineVertex;

typedef int (*PolylineVertexConsumer) (void *context,
                                       const PolylineVertex *vertex);

typedef struct
{
  uint16_t kind;
  uint16_t flags;
  double elevation;
  double thickness;
  double normal[3];
  double default_start_width;
  double default_end_width;
  double constant_width;
  int closed;
} PolylineInfo;

typedef struct
{
  size_t degree;
  size_t control_count;
  size_t nonzero_spans;
  unsigned segments_per_span;
  unsigned segment_count;
  double domain_start;
  double domain_end;
  int uniform_domain;
} SplineSampling;

typedef struct
{
  CacheWriter *writer;
  LibreDwgGpuLineSummary *summary;
  uint32_t current_group;
  uint32_t count;
  uint32_t batch_flags;
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
  double midpoint_min[2];
  double midpoint_max[2];
  int has_midpoint_bounds;
} OverviewGroup;

typedef struct
{
  OverviewGroup *groups;
  size_t group_count;
  uint64_t quota_total;
} OverviewPlan;

typedef struct
{
  LineSegment segment;
  uint64_t source_order;
  uint32_t morton;
  uint32_t reserved;
} SpatialSegmentRecord;

typedef struct
{
  FILE *file;
  uint64_t count;
} SpatialSegmentStore;

typedef struct
{
  uint64_t start;
  uint64_t count;
} SpatialSortRun;

typedef struct
{
  uint64_t next;
  uint64_t remaining;
  size_t buffered;
  size_t position;
  SpatialSegmentRecord buffer[SPATIAL_MERGE_BUFFER_RECORDS];
} SpatialMergeRun;

typedef struct
{
  double (*vertices)[3];
  size_t vertex_count;
  uint32_t source_edge_count;
  int approximated_curve;
  double signed_area;
} HatchRing;

typedef struct
{
  LineSegment *segments;
  size_t capacity;
  size_t count;
} HatchSegmentCollector;

typedef int (*HatchRingConsumer) (
    void *context, const Dwg_Object *object,
    const Dwg_Entity_HATCH *hatch, uint64_t hatch_index,
    uint32_t path_index, const Dwg_HATCH_Path *path,
    const HatchRing *ring);

typedef struct
{
  uint64_t global_vertices;
  uint64_t global_gradient_colors;
  uint64_t global_seed_points;
  uint64_t loops;
  uint64_t vertices;
  uint64_t gradient_colors;
  uint64_t seed_points;
  uint64_t skipped_open_paths;
  uint64_t skipped_invalid_paths;
  int truncated;
} HatchEntityScan;

typedef struct
{
  uint64_t lines;
  uint64_t dashes;
  uint64_t invalid_lines;
  int truncated;
} HatchPatternScan;

typedef int (*HatchPatternLineConsumer) (
    void *context, uint64_t hatch_index, uint32_t source_line_index,
    const Dwg_HATCH_DefLine *line, uint64_t first_dash,
    uint32_t dash_count);

typedef struct
{
  OverviewPlan *overview;
  LineSegmentConsumer consumer;
  void *consumer_context;
  uint64_t emitted;
  uint64_t skipped;
  uint64_t approximated;
} SegmentIteration;

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
        SECTION_TEXT_STYLES,
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
        SECTION_TEXT_ENTITIES,
        SECTION_TEXT_COLUMN_HEIGHTS,
        SECTION_GPU_LINE_BATCHES,
        SECTION_GPU_LINE_VERTICES,
        SECTION_HATCH_ENTITIES,
        SECTION_HATCH_LOOPS,
        SECTION_HATCH_VERTICES,
        SECTION_HATCH_GRADIENT_COLORS,
        SECTION_HATCH_SEED_POINTS,
        SECTION_HATCH_PATTERN_LINES,
        SECTION_HATCH_PATTERN_DASHES,
        SECTION_POINT_ENTITIES,
        SECTION_SOLID_ENTITIES,
        SECTION_FACE_ENTITIES,
        SECTION_WIPEOUT_ENTITIES,
        SECTION_WIPEOUT_CLIP_VERTICES };

static const uint32_t SECTION_RECORD_SIZES[LIBREDWG_SCENE_SECTION_COUNT]
    = { DRAWING_RECORD_SIZE,
        LAYER_RECORD_SIZE,
        BLOCK_RECORD_SIZE,
        TEXT_STYLE_RECORD_SIZE,
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
        TEXT_ENTITY_RECORD_SIZE,
        TEXT_COLUMN_HEIGHT_RECORD_SIZE,
        GPU_LINE_BATCH_RECORD_SIZE,
        GPU_LINE_VERTEX_RECORD_SIZE,
        HATCH_ENTITY_RECORD_SIZE,
        HATCH_LOOP_RECORD_SIZE,
        HATCH_VERTEX_RECORD_SIZE,
        HATCH_GRADIENT_COLOR_RECORD_SIZE,
        HATCH_SEED_POINT_RECORD_SIZE,
        HATCH_PATTERN_LINE_RECORD_SIZE,
        HATCH_PATTERN_DASH_RECORD_SIZE,
        POINT_ENTITY_RECORD_SIZE,
        SOLID_ENTITY_RECORD_SIZE,
        FACE_ENTITY_RECORD_SIZE,
        WIPEOUT_ENTITY_RECORD_SIZE,
        WIPEOUT_CLIP_VERTEX_RECORD_SIZE };

static const char *const SECTION_NAMES[LIBREDWG_SCENE_SECTION_COUNT]
    = { "drawing",
        "layers",
        "blocks",
        "text_styles",
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
        "text_entities",
        "text_column_heights",
        "gpu_line_batches",
        "gpu_line_vertices",
        "hatch_entities",
        "hatch_loops",
        "hatch_vertices",
        "hatch_gradient_colors",
        "hatch_seed_points",
        "hatch_pattern_lines",
        "hatch_pattern_dashes",
        "point_entities",
        "solid_entities",
        "face_entities",
        "wipeout_entities",
        "wipeout_clip_vertices" };

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
write_u8 (CacheWriter *writer, uint8_t value)
{
  return write_bytes (writer, &value, sizeof (value));
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
  for (i = 0; i < tables->text_style_count; i++)
    {
      free (tables->text_styles[i].name);
      free (tables->text_styles[i].font_file);
      free (tables->text_styles[i].bigfont_file);
    }
  free (tables->layers);
  free (tables->layer_indices);
  free (tables->blocks);
  free (tables->block_indices);
  free (tables->text_styles);
  free (tables->text_style_indices);
  memset (tables, 0, sizeof (*tables));
}

static int
build_tables (Dwg_Data *dwg, CacheTables *tables)
{
  size_t layer_count = 0;
  size_t block_count = 0;
  size_t text_style_count = 0;
  size_t layer_index = 0;
  size_t block_index = 0;
  size_t text_style_index = 0;
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
      else if (dwg->object[i].fixedtype == DWG_TYPE_STYLE)
        text_style_count++;
    }
  if (layer_count > UINT32_MAX || block_count > UINT32_MAX
      || text_style_count > UINT32_MAX)
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
  tables->text_styles
      = text_style_count
            ? (TextStyleEntry *)calloc (text_style_count,
                                       sizeof (TextStyleEntry))
            : NULL;
  tables->text_style_indices
      = text_style_count
            ? (HandleIndex *)malloc (text_style_count * sizeof (HandleIndex))
            : NULL;
  if ((layer_count && (!tables->layers || !tables->layer_indices))
      || (block_count && (!tables->blocks || !tables->block_indices))
      || (text_style_count
          && (!tables->text_styles || !tables->text_style_indices)))
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
  tables->text_style_count = text_style_count;

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
      else if (object->fixedtype == DWG_TYPE_STYLE && object->tio.object
               && object->tio.object->tio.STYLE)
        {
          TextStyleEntry *entry
              = &tables->text_styles[text_style_index];
          Dwg_Object_STYLE *style = object->tio.object->tio.STYLE;
          entry->object = object;
          entry->handle = (uint64_t)object->handle.value;
          entry->name
              = copy_utf8_field (style, "STYLE", "name", "");
          entry->font_file
              = copy_utf8_field (style, "STYLE", "font_file", "");
          entry->bigfont_file
              = copy_utf8_field (style, "STYLE", "bigfont_file", "");
          if (!entry->name || !entry->font_file || !entry->bigfont_file)
            {
              free_tables (tables);
              return 0;
            }
          tables->text_style_indices[text_style_index].handle = entry->handle;
          tables->text_style_indices[text_style_index].index
              = (uint32_t)text_style_index;
          text_style_index++;
        }
    }
  tables->layer_count = layer_index;
  tables->block_count = block_index;
  tables->text_style_count = text_style_index;
  qsort (tables->layer_indices, tables->layer_count, sizeof (HandleIndex),
         handle_index_compare);
  qsort (tables->block_indices, tables->block_count, sizeof (HandleIndex),
         handle_index_compare);
  qsort (tables->text_style_indices, tables->text_style_count,
         sizeof (HandleIndex), handle_index_compare);
  return 1;
}

static uint32_t
encode_color (const Dwg_Color *color)
{
  uint32_t method;
  uint32_t packed;

  if (!color)
    return 0;

  /*
   * LibreDWG's public method enum labels 0xc3 as TRUECOLOR, but its CMC/DXF
   * readers use 0xc2 for direct RGB and 0xc3 for ACI. Entity ENC colors leave
   * method unset, so derive it from their packed value as well.
   *
   * LibreDWG's common-entity path also decodes ENC alpha before RGB,
   * unlike its bit_read_ENC helper and the public HATCH qualification fixture.
   * With both 0x80 and 0x20 present, that fixture therefore exposes packed RGB
   * through alpha_raw. Prefer it only when it carries a valid direct-RGB
   * method and the nominal RGB field does not.
   */
  packed = (uint32_t)color->rgb;
  if ((color->flag & 0xa0u) == 0xa0u
      && (packed >> 24) != 0xc2u
      && ((uint32_t)color->alpha_raw >> 24) == 0xc2u)
    packed = (uint32_t)color->alpha_raw;

  method = (uint32_t)color->method;
  if (!method)
    method = packed >> 24;

  if (method == 0xc2u)
    return (3u << 30) | (packed & 0x00ffffffu);
  if (color->index == 256 || method == DWG_COLOR_METHOD_BYLAYER)
    return 0;
  if (color->index == 0 || method == DWG_COLOR_METHOD_BYBLOCK)
    return 1u << 30;
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

static void
finite_normal_or_unit_z (double x, double y, double z, double normal[3])
{
  double length_squared = x * x + y * y + z * z;
  if (isfinite (x) && isfinite (y) && isfinite (z)
      && isfinite (length_squared) && length_squared > 1.0e-24)
    {
      normal[0] = x;
      normal[1] = y;
      normal[2] = z;
    }
  else
    {
      normal[0] = 0.0;
      normal[1] = 0.0;
      normal[2] = 1.0;
    }
}

static int
read_polyline_info (const Dwg_Object *object, PolylineInfo *info)
{
  memset (info, 0, sizeof (*info));
  if (!object || !object->tio.entity)
    return 0;
  if (object->fixedtype == DWG_TYPE_LWPOLYLINE
      && object->tio.entity->tio.LWPOLYLINE)
    {
      const Dwg_Entity_LWPOLYLINE *polyline
          = object->tio.entity->tio.LWPOLYLINE;
      info->kind = 1;
      info->closed = (polyline->flag & 512u) != 0;
      info->flags = (uint16_t)(info->closed ? 1u : 0u);
      if (polyline->flag & 256u)
        info->flags |= 1u << 7;
      info->elevation = polyline->elevation;
      info->thickness = polyline->thickness;
      finite_normal_or_unit_z (polyline->extrusion.x,
                               polyline->extrusion.y,
                               polyline->extrusion.z, info->normal);
      info->constant_width = polyline->const_width;
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_POLYLINE_2D
      && object->tio.entity->tio.POLYLINE_2D)
    {
      const Dwg_Entity_POLYLINE_2D *polyline
          = object->tio.entity->tio.POLYLINE_2D;
      info->kind = 2;
      info->flags = (uint16_t)polyline->flag;
      info->closed = (polyline->flag & 1u) != 0;
      info->elevation = polyline->elevation;
      info->thickness = polyline->thickness;
      finite_normal_or_unit_z (polyline->extrusion.x,
                               polyline->extrusion.y,
                               polyline->extrusion.z, info->normal);
      info->default_start_width = polyline->start_width;
      info->default_end_width = polyline->end_width;
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_POLYLINE_3D
      && object->tio.entity->tio.POLYLINE_3D)
    {
      const Dwg_Entity_POLYLINE_3D *polyline
          = object->tio.entity->tio.POLYLINE_3D;
      info->kind = 3;
      info->flags = (uint16_t)polyline->flag;
      info->closed = (polyline->flag & 1u) != 0;
      info->normal[2] = 1.0;
      return 1;
    }
  return 0;
}

static int
consume_polyline_subentity (const Dwg_Object *vertex_object, uint16_t kind,
                            PolylineVertexConsumer consumer, void *context,
                            uint64_t *count)
{
  PolylineVertex vertex;
  memset (&vertex, 0, sizeof (vertex));
  if (!vertex_object || !vertex_object->tio.entity)
    return 1;
  if (kind == 2 && vertex_object->fixedtype == DWG_TYPE_VERTEX_2D
      && vertex_object->tio.entity->tio.VERTEX_2D)
    {
      const Dwg_Entity_VERTEX_2D *source
          = vertex_object->tio.entity->tio.VERTEX_2D;
      vertex.position[0] = source->point.x;
      vertex.position[1] = source->point.y;
      vertex.position[2] = source->point.z;
      vertex.bulge = source->bulge;
      vertex.start_width = source->start_width;
      vertex.end_width = source->end_width;
      vertex.curve_tangent = source->tangent_dir;
      vertex.flags = (uint32_t)source->flag;
      vertex.id = (int32_t)(uint32_t)source->id;
    }
  else if (kind == 3 && vertex_object->fixedtype == DWG_TYPE_VERTEX_3D
           && vertex_object->tio.entity->tio.VERTEX_3D)
    {
      const Dwg_Entity_VERTEX_3D *source
          = vertex_object->tio.entity->tio.VERTEX_3D;
      vertex.position[0] = source->point.x;
      vertex.position[1] = source->point.y;
      vertex.position[2] = source->point.z;
      vertex.flags = (uint32_t)source->flag;
    }
  else
    return 1;
  if (consumer && !consumer (context, &vertex))
    return 0;
  (*count)++;
  return 1;
}

static int
iterate_polyline_vertices (const Dwg_Object *object,
                           PolylineVertexConsumer consumer, void *context,
                           uint64_t *vertex_count)
{
  PolylineInfo info;
  uint64_t count = 0;
  if (!read_polyline_info (object, &info))
    {
      if (vertex_count)
        *vertex_count = 0;
      return 1;
    }
  if (info.kind == 1)
    {
      const Dwg_Entity_LWPOLYLINE *polyline
          = object->tio.entity->tio.LWPOLYLINE;
      uint64_t i;
      if (polyline->num_points && !polyline->points)
        {
          if (vertex_count)
            *vertex_count = 0;
          return 1;
        }
      for (i = 0; i < (uint64_t)polyline->num_points; i++)
        {
          PolylineVertex vertex;
          memset (&vertex, 0, sizeof (vertex));
          vertex.position[0] = polyline->points[i].x;
          vertex.position[1] = polyline->points[i].y;
          vertex.position[2] = polyline->elevation;
          if (polyline->bulges && i < (uint64_t)polyline->num_bulges)
            vertex.bulge = polyline->bulges[i];
          if (polyline->widths && i < (uint64_t)polyline->num_widths)
            {
              vertex.start_width = polyline->widths[i].start;
              vertex.end_width = polyline->widths[i].end;
            }
          if (polyline->vertexids
              && i < (uint64_t)polyline->num_vertexids)
            vertex.id = (int32_t)(uint32_t)polyline->vertexids[i];
          if (consumer && !consumer (context, &vertex))
            return 0;
          count++;
        }
    }
  else
    {
      Dwg_Data *dwg = object->parent;
      BITCODE_H *references = NULL;
      BITCODE_H first = NULL;
      BITCODE_H last = NULL;
      uint64_t declared = 0;
      Dwg_Version_Type version;
      if (!dwg)
        {
          if (vertex_count)
            *vertex_count = 0;
          return 1;
        }
      version = dwg->header.version;
      if (info.kind == 2)
        {
          const Dwg_Entity_POLYLINE_2D *polyline
              = object->tio.entity->tio.POLYLINE_2D;
          declared = (uint64_t)polyline->num_owned;
          references = polyline->vertex;
          first = polyline->first_vertex;
          last = polyline->last_vertex;
        }
      else
        {
          const Dwg_Entity_POLYLINE_3D *polyline
              = object->tio.entity->tio.POLYLINE_3D;
          declared = (uint64_t)polyline->num_owned;
          references = polyline->vertex;
          first = polyline->first_vertex;
          last = polyline->last_vertex;
        }
      if (version < R_13b1)
        {
          Dwg_Object *current = dwg_next_object (object);
          uint64_t visited = 0;
          uint64_t limit = (uint64_t)dwg->num_objects;
          Dwg_Object_Type expected_type
              = info.kind == 2 ? DWG_TYPE_VERTEX_2D
                               : DWG_TYPE_VERTEX_3D;
          while (current && visited < limit
                 && current->fixedtype != DWG_TYPE_SEQEND)
            {
              Dwg_Object *next;
              if (current->fixedtype != expected_type)
                break;
              visited++;
              if (!consume_polyline_subentity (
                      current, info.kind, consumer, context, &count))
                return 0;
              next = dwg_next_object (current);
              current = next;
            }
        }
      else if (version <= R_2000)
        {
          Dwg_Object *current
              = first ? dwg_ref_object_silent (dwg, first) : NULL;
          uint64_t visited = 0;
          uint64_t limit = (uint64_t)dwg->num_objects;
          while (current && visited < limit)
            {
              Dwg_Object *next;
              visited++;
              if (!consume_polyline_subentity (
                      current, info.kind, consumer, context, &count))
                return 0;
              if (last && current == last->obj)
                break;
              next = dwg_next_object (current);
              if (!next || next->fixedtype == DWG_TYPE_SEQEND)
                break;
              current = next;
            }
        }
      else if (references)
        {
          uint64_t i;
          uint64_t limit
              = declared < (uint64_t)dwg->num_objects
                    ? declared
                    : (uint64_t)dwg->num_objects;
          for (i = 0; i < limit; i++)
            {
              Dwg_Object *current
                  = references[i]
                        ? dwg_ref_object_silent (dwg, references[i])
                        : NULL;
              if (!consume_polyline_subentity (
                      current, info.kind, consumer, context, &count))
                return 0;
            }
        }
    }
  if (vertex_count)
    *vertex_count = count;
  return 1;
}

static uint64_t
polyline_vertex_count (const Dwg_Object *object)
{
  uint64_t count = 0;
  (void)iterate_polyline_vertices (object, NULL, NULL, &count);
  return count;
}

static size_t
spline_knot_count (const Dwg_Entity_SPLINE *spline)
{
  if (!spline || !spline->knots || spline->num_knots <= 0)
    return 0;
  return (size_t)spline->num_knots;
}

static size_t
spline_control_point_count (const Dwg_Entity_SPLINE *spline)
{
  if (!spline || !spline->ctrl_pts || spline->num_ctrl_pts <= 0)
    return 0;
  return (size_t)spline->num_ctrl_pts;
}

static size_t
spline_weight_count (const Dwg_Entity_SPLINE *spline)
{
  return spline && spline->weighted
             ? spline_control_point_count (spline)
             : 0;
}

static size_t
spline_fit_point_count (const Dwg_Entity_SPLINE *spline)
{
  if (!spline || !spline->fit_pts || spline->num_fit_pts <= 0)
    return 0;
  return (size_t)spline->num_fit_pts;
}

static int
spline_is_closed (const Dwg_Entity_SPLINE *spline)
{
  return spline
         && (spline->closed_b || (spline->splineflags & 4u) != 0);
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

static const Dwg_DIMENSION_common *
dimension_common (const Dwg_Object *object)
{
  if (!object || !object->tio.entity)
    return NULL;
  switch (object->fixedtype)
    {
    case DWG_TYPE_DIMENSION_LINEAR:
    case DWG_TYPE_DIMENSION_ALIGNED:
    case DWG_TYPE_DIMENSION_ANG2LN:
    case DWG_TYPE_DIMENSION_ANG3PT:
    case DWG_TYPE_DIMENSION_RADIUS:
    case DWG_TYPE_DIMENSION_DIAMETER:
    case DWG_TYPE_DIMENSION_ORDINATE:
      return object->tio.entity->tio.DIMENSION_common;
    default:
      return NULL;
    }
}

static int
dimension_block_target (const Dwg_Object *object,
                        const CacheTables *tables, uint64_t *target_handle,
                        double base_point[3])
{
  const Dwg_DIMENSION_common *dimension = dimension_common (object);
  uint64_t handle;
  uint32_t block_index;
  Dwg_Object_BLOCK_HEADER *block;
  if (!dimension)
    return 0;
  handle = reference_handle (dimension->block);
  block_index = find_handle_index (tables->block_indices,
                                   tables->block_count, handle);
  if (block_index == UINT32_MAX || block_index >= tables->block_count
      || !tables->blocks[block_index].object
      || !tables->blocks[block_index].object->tio.object
      || !(block = tables->blocks[block_index]
                       .object->tio.object->tio.BLOCK_HEADER))
    return 0;
  base_point[0] = block->base_pt.x;
  base_point[1] = block->base_pt.y;
  base_point[2] = block->base_pt.z;
  if (!isfinite (base_point[0]) || !isfinite (base_point[1])
      || !isfinite (base_point[2]))
    return 0;
  *target_handle = handle;
  return 1;
}

static LibreDwgPrimitiveCounts
count_primitives (const Dwg_Data *dwg, const CacheTables *tables)
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
        case DWG_TYPE_LWPOLYLINE:
          counts.lwpolylines++;
          counts.polyline_vertices
              += polyline_vertex_count (object);
          break;
        case DWG_TYPE_POLYLINE_2D:
          counts.polylines_2d++;
          counts.polyline_vertices
              += polyline_vertex_count (object);
          break;
        case DWG_TYPE_POLYLINE_3D:
          counts.polylines_3d++;
          counts.polyline_vertices
              += polyline_vertex_count (object);
          break;
        case DWG_TYPE_ELLIPSE:
          counts.ellipses++;
          break;
        case DWG_TYPE_SPLINE:
          if (object->tio.entity
              && object->tio.entity->tio.SPLINE)
            {
              const Dwg_Entity_SPLINE *spline
                  = object->tio.entity->tio.SPLINE;
              counts.splines++;
              counts.spline_knots += spline_knot_count (spline);
              counts.spline_weights += spline_weight_count (spline);
              counts.spline_control_points
                  += spline_control_point_count (spline);
              counts.spline_fit_points
                  += spline_fit_point_count (spline);
            }
          break;
        case DWG_TYPE_TEXT:
          counts.texts++;
          break;
        case DWG_TYPE_MTEXT:
          counts.mtexts++;
          break;
        case DWG_TYPE_ATTDEF:
          counts.attribute_definitions++;
          break;
        case DWG_TYPE_HATCH:
          if (object->tio.entity
              && object->tio.entity->tio.HATCH)
            counts.hatches++;
          break;
        case DWG_TYPE_POINT:
          if (object->tio.entity && object->tio.entity->tio.POINT)
            counts.points++;
          break;
        case DWG_TYPE_SOLID:
          if (object->tio.entity && object->tio.entity->tio.SOLID)
            counts.solids++;
          break;
        case DWG_TYPE__3DFACE:
          if (object->tio.entity && object->tio.entity->tio._3DFACE)
            counts.faces++;
          break;
        case DWG_TYPE_WIPEOUT:
          if (object->tio.entity && object->tio.entity->tio.WIPEOUT)
            counts.wipeouts++;
          break;
        case DWG_TYPE_DIMENSION_LINEAR:
        case DWG_TYPE_DIMENSION_ALIGNED:
        case DWG_TYPE_DIMENSION_ANG2LN:
        case DWG_TYPE_DIMENSION_ANG3PT:
        case DWG_TYPE_DIMENSION_RADIUS:
        case DWG_TYPE_DIMENSION_DIAMETER:
        case DWG_TYPE_DIMENSION_ORDINATE:
          {
            uint64_t target_handle;
            double base_point[3];
            if (dimension_block_target (object, tables, &target_handle,
                                        base_point))
              counts.dimensions++;
          }
          break;
        default:
          break;
        }
    }
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_ATTRIB && object->tio.entity
          && object->tio.entity->tio.ATTRIB)
        counts.attributes++;
    }
  counts.serialized_entities = counts.lines + counts.arcs + counts.circles
                               + counts.inserts + counts.lwpolylines
                               + counts.dimensions
                               + counts.polylines_2d
                               + counts.polylines_3d + counts.ellipses
                               + counts.splines + counts.texts
                               + counts.mtexts
                               + counts.attribute_definitions
                               + counts.hatches + counts.points
                               + counts.solids + counts.faces
                               + counts.wipeouts;
  counts.deferred_entities
      = counts.total_entities - counts.serialized_entities;
  return counts;
}

static int
read_drawing_wipeout_frame (CacheWriter *writer, const Dwg_Data *dwg,
                            uint32_t *result)
{
  uint32_t setting = UINT32_MAX;
  size_t object_index;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Object_WIPEOUTVARIABLES *variables;
      uint32_t raw;
      if (object->fixedtype != DWG_TYPE_WIPEOUTVARIABLES
          || !object->tio.object
          || !(variables = object->tio.object->tio.WIPEOUTVARIABLES))
        continue;
      raw = (uint32_t)variables->display_frame;
      if (raw > 2u)
        {
          set_error (
              writer,
              "WIPEOUT frame setting is outside the supported range");
          return 0;
        }
      if (setting != UINT32_MAX && setting != raw)
        {
          set_error (
              writer,
              "drawing contains conflicting WIPEOUT frame settings");
          return 0;
        }
      setting = raw;
    }
  *result = setting;
  return 1;
}

static int
write_drawing_section (CacheWriter *writer, Dwg_Data *dwg,
                       const LibreDwgPrimitiveCounts *counts,
                       uint32_t source_version, uint32_t wipeout_frame,
                       SectionEntry *entry)
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
      || !write_u32 (writer,
                     (uint32_t)LIBREDWG_MAINTENANCE_VERSION (dwg))
      || !write_i32 (writer, (int32_t)dwg->header_vars.INSUNITS)
      || !write_u32 (writer, wipeout_frame)
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

static int16_t
normalize_mtext_flow_direction (int value)
{
  if (value == 1)
    return 1;
  if (value == 3)
    return 2;
  if (value == 5)
    return 3;
  return 0;
}

static void
free_text_source (TextSource *source)
{
  free (source->value);
  free (source->tag);
  free (source->prompt);
  source->value = NULL;
  source->tag = NULL;
  source->prompt = NULL;
}

static void
copy_embedded_mtext (TextSource *source,
                     const Dwg_AcDbMTextObjectEmbedded *mtext)
{
  source->attachment = (int16_t)mtext->attachment;
  source->x_axis_direction[0] = mtext->x_axis_dir.x;
  source->x_axis_direction[1] = mtext->x_axis_dir.y;
  source->x_axis_direction[2] = mtext->x_axis_dir.z;
  source->rectangle_height = mtext->rect_height;
  source->rectangle_width = mtext->rect_width;
  source->extents_width = mtext->extents_width;
  source->extents_height = mtext->extents_height;
  source->column_type = (int32_t)mtext->column_type;
  source->column_count = (int32_t)mtext->num_column_heights;
  source->column_width = mtext->column_width;
  source->column_gutter = mtext->gutter;
  if (mtext->auto_height)
    source->column_flags |= 1u;
  if (mtext->flow_reversed)
    source->column_flags |= 1u << 1;
  if (mtext->num_column_heights > 0 && mtext->column_heights)
    {
      source->column_heights = mtext->column_heights;
      source->column_height_count
          = (uint64_t)mtext->num_column_heights;
    }
}

static int
read_text_source (const Dwg_Object *object, TextSource *source)
{
  const char *value_type;
  const char *value_field;
  const char *tag_type = "";
  const char *prompt_type = "";
  memset (source, 0, sizeof (*source));
  source->object = object;
  source->normal[2] = 1.0;
  source->x_axis_direction[0] = 1.0;
  source->width_factor = 1.0;
  source->line_count = 1;
  if (!object || !object->tio.entity)
    return 0;

  switch (object->fixedtype)
    {
    case DWG_TYPE_TEXT:
      {
        const Dwg_Entity_TEXT *text = object->tio.entity->tio.TEXT;
        if (!text)
          return 0;
        source->kind = 0;
        value_type = "TEXT";
        value_field = "text_value";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->elevation;
        source->alignment_point[0] = text->alignment_pt.x;
        source->alignment_point[1] = text->alignment_pt.y;
        source->alignment_point[2] = text->elevation;
        if ((text->dataflags & 2u) || text->horiz_alignment
            || text->vert_alignment)
          source->flags |= TEXT_FLAG_HAS_ALIGNMENT_POINT;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->height = text->height;
        source->width_factor = text->width_factor;
        source->rotation = text->rotation;
        source->oblique_angle = text->oblique_angle;
        source->thickness = text->thickness;
        source->x_axis_direction[0] = cos (text->rotation);
        source->x_axis_direction[1] = sin (text->rotation);
        source->horizontal_alignment
            = (int16_t)text->horiz_alignment;
        source->vertical_alignment = (int16_t)text->vert_alignment;
        source->generation_flags = (int16_t)text->generation;
        break;
      }
    case DWG_TYPE_MTEXT:
      {
        const Dwg_Entity_MTEXT *text = object->tio.entity->tio.MTEXT;
        if (!text)
          return 0;
        source->kind = 1;
        value_type = "MTEXT";
        value_field = "text";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->ins_pt.z;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->x_axis_direction[0] = text->x_axis_dir.x;
        source->x_axis_direction[1] = text->x_axis_dir.y;
        source->x_axis_direction[2] = text->x_axis_dir.z;
        source->rotation
            = atan2 (text->x_axis_dir.y, text->x_axis_dir.x);
        source->height = text->text_height;
        source->rectangle_width = text->rect_width;
        source->rectangle_height = text->rect_height;
        source->flags |= TEXT_FLAG_HAS_RECTANGLE_HEIGHT;
        if (!text->is_not_annotative)
          source->flags |= TEXT_FLAG_ANNOTATIVE;
        source->extents_width = text->extents_width;
        source->extents_height = text->extents_height;
        source->attachment = (int16_t)text->attachment;
        source->flow_direction
            = normalize_mtext_flow_direction (text->flow_dir);
        source->line_spacing_style = (int16_t)text->linespace_style;
        source->line_spacing_factor = text->linespace_factor;
        source->background_flags = (int32_t)text->bg_fill_flag;
        source->background_scale = (double)text->bg_fill_scale;
        source->background_color
            = encode_color (&text->bg_fill_color);
        source->background_transparency
            = (int32_t)text->bg_fill_trans;
        source->column_type = (int32_t)text->column_type;
        source->column_count
            = text->column_type == 1 ? (int32_t)text->numfragments
                                     : (int32_t)text->num_column_heights;
        source->column_width = text->column_width;
        source->column_gutter = text->gutter;
        if (text->auto_height)
          source->column_flags |= 1u;
        if (text->flow_reversed)
          source->column_flags |= 1u << 1;
        if (text->num_column_heights > 0 && text->column_heights)
          {
            source->column_heights = text->column_heights;
            source->column_height_count
                = (uint64_t)text->num_column_heights;
          }
        source->line_count = 0;
        break;
      }
    case DWG_TYPE_ATTDEF:
      {
        const Dwg_Entity_ATTDEF *text = object->tio.entity->tio.ATTDEF;
        if (!text)
          return 0;
        source->kind = 2;
        value_type = "ATTDEF";
        value_field = "default_value";
        tag_type = "ATTDEF";
        prompt_type = "ATTDEF";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->elevation;
        source->alignment_point[0] = text->alignment_pt.x;
        source->alignment_point[1] = text->alignment_pt.y;
        source->alignment_point[2] = text->elevation;
        source->flags |= TEXT_FLAG_HAS_ALIGNMENT_POINT;
        if (text->annotative_flag)
          source->flags |= TEXT_FLAG_ANNOTATIVE;
        if (text->mtext_type)
          source->flags |= TEXT_FLAG_MULTILINE;
        if (text->lock_position_flag)
          source->flags |= TEXT_FLAG_LOCK_POSITION;
        if (text->is_really_locked)
          source->flags |= TEXT_FLAG_REALLY_LOCKED;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->height = text->height;
        source->width_factor = text->width_factor;
        source->rotation = text->rotation;
        source->oblique_angle = text->oblique_angle;
        source->thickness = text->thickness;
        source->x_axis_direction[0] = cos (text->rotation);
        source->x_axis_direction[1] = sin (text->rotation);
        source->source_flags = (int32_t)text->flags;
        source->horizontal_alignment
            = (int16_t)text->horiz_alignment;
        source->vertical_alignment = (int16_t)text->vert_alignment;
        source->generation_flags = (int16_t)text->generation;
        source->field_length = (int16_t)text->field_length;
        source->mtext_type = (int16_t)text->mtext_type;
        if (text->mtext_type)
          copy_embedded_mtext (source, &text->mtext);
        break;
      }
    case DWG_TYPE_ATTRIB:
      {
        const Dwg_Entity_ATTRIB *text = object->tio.entity->tio.ATTRIB;
        if (!text)
          return 0;
        source->kind = 3;
        value_type = "ATTRIB";
        value_field = "text_value";
        tag_type = "ATTRIB";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->elevation;
        source->alignment_point[0] = text->alignment_pt.x;
        source->alignment_point[1] = text->alignment_pt.y;
        source->alignment_point[2] = text->elevation;
        source->flags |= TEXT_FLAG_HAS_ALIGNMENT_POINT;
        if (text->annotative_flag)
          source->flags |= TEXT_FLAG_ANNOTATIVE;
        if (text->mtext_type)
          source->flags |= TEXT_FLAG_MULTILINE;
        if (text->lock_position_flag)
          source->flags |= TEXT_FLAG_LOCK_POSITION;
        if (text->is_really_locked)
          source->flags |= TEXT_FLAG_REALLY_LOCKED;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->height = text->height;
        source->width_factor = text->width_factor;
        source->rotation = text->rotation;
        source->oblique_angle = text->oblique_angle;
        source->thickness = text->thickness;
        source->x_axis_direction[0] = cos (text->rotation);
        source->x_axis_direction[1] = sin (text->rotation);
        source->source_flags = (int32_t)text->flags;
        source->horizontal_alignment
            = (int16_t)text->horiz_alignment;
        source->vertical_alignment = (int16_t)text->vert_alignment;
        source->generation_flags = (int16_t)text->generation;
        source->field_length = (int16_t)text->field_length;
        source->mtext_type = (int16_t)text->mtext_type;
        if (text->mtext_type)
          copy_embedded_mtext (source, &text->mtext);
        break;
      }
    default:
      return 0;
    }

  source->value = copy_utf8_field (
      (void *)(source->kind == 0
                   ? (void *)object->tio.entity->tio.TEXT
                   : source->kind == 1
                         ? (void *)object->tio.entity->tio.MTEXT
                         : source->kind == 2
                               ? (void *)object->tio.entity->tio.ATTDEF
                               : (void *)object->tio.entity->tio.ATTRIB),
      value_type, value_field, "");
  source->tag = copy_utf8_field (
      source->kind == 2
          ? (void *)object->tio.entity->tio.ATTDEF
          : source->kind == 3 ? (void *)object->tio.entity->tio.ATTRIB : NULL,
      tag_type, "tag", "");
  source->prompt = copy_utf8_field (
      source->kind == 2 ? (void *)object->tio.entity->tio.ATTDEF : NULL,
      prompt_type, "prompt", "");
  if (!source->value || !source->tag || !source->prompt)
    {
      free_text_source (source);
      return 0;
    }
  return 1;
}

static int
write_text_style_section (CacheWriter *writer, const CacheTables *tables,
                          SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint32_t *references;
  size_t i;
  if (tables->text_style_count > SIZE_MAX / (8 * sizeof (uint32_t)))
    {
      set_error (writer, "too many text styles for scene cache");
      return 0;
    }
  references
      = tables->text_style_count
            ? (uint32_t *)malloc (tables->text_style_count * 8
                                 * sizeof (uint32_t))
            : NULL;
  if (tables->text_style_count && !references)
    {
      set_error (writer, "out of memory while writing text-style table");
      return 0;
    }
  for (i = 0; i < tables->text_style_count; i++)
    {
      TextStyleEntry *style = &tables->text_styles[i];
      if (!checked_string_layout (&string_cursor, style->name,
                                  &references[i * 8],
                                  &references[i * 8 + 1])
          || !checked_string_layout (&string_cursor, style->font_file,
                                     &references[i * 8 + 2],
                                     &references[i * 8 + 3])
          || !checked_string_layout (&string_cursor, style->bigfont_file,
                                     &references[i * 8 + 4],
                                     &references[i * 8 + 5])
          || !checked_string_layout (&string_cursor, "",
                                     &references[i * 8 + 6],
                                     &references[i * 8 + 7]))
        {
          free (references);
          set_error (writer, "text-style string table exceeds its limits");
          return 0;
        }
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE
        + (uint64_t)tables->text_style_count * TEXT_STYLE_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)tables->text_style_count)
      || !write_u32 (writer, TEXT_STYLE_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }
  for (i = 0; i < tables->text_style_count; i++)
    {
      Dwg_Object_STYLE *style
          = tables->text_styles[i].object->tio.object->tio.STYLE;
      uint32_t flags = 0;
      size_t j;
      if ((style->generation & 2u) || (style->flag & 128u))
        flags |= 1u;
      if ((style->generation & 4u) || (style->flag & 2u))
        flags |= 1u << 1;
      if (style->is_xref_dep)
        flags |= 1u << 2;
      if (style->is_vertical)
        flags |= 1u << 4;
      if (style->is_shape)
        flags |= 1u << 5;
      if (!write_u64 (writer, tables->text_styles[i].handle))
        {
          free (references);
          return 0;
        }
      for (j = 0; j < 8; j++)
        {
          if (!write_u32 (writer, references[i * 8 + j]))
            {
              free (references);
              return 0;
            }
        }
      if (!write_u32 (writer, flags) || !write_u32 (writer, 0)
          || !write_f64 (writer, style->text_size)
          || !write_f64 (writer, style->width_factor)
          || !write_f64 (writer, style->oblique_angle)
          || !write_f64 (writer, style->last_height)
          || !write_u64 (writer, 0) || !write_u64 (writer, 0))
        {
          free (references);
          return 0;
        }
    }
  for (i = 0; i < tables->text_style_count; i++)
    {
      if (!write_bytes (writer, tables->text_styles[i].name,
                        strlen (tables->text_styles[i].name))
          || !write_bytes (writer, tables->text_styles[i].font_file,
                           strlen (tables->text_styles[i].font_file))
          || !write_bytes (writer, tables->text_styles[i].bigfont_file,
                           strlen (tables->text_styles[i].bigfont_file)))
        {
          free (references);
          return 0;
        }
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_TEXT_STYLES, TEXT_STYLE_RECORD_SIZE,
      "text_styles", offset, (uint64_t)tables->text_style_count,
      SECTION_FLAG_STRING_TABLE);
}

static int
is_text_source_object (const Dwg_Object *object)
{
  return object && (object->fixedtype == DWG_TYPE_TEXT
                    || object->fixedtype == DWG_TYPE_MTEXT
                    || object->fixedtype == DWG_TYPE_ATTDEF
                    || object->fixedtype == DWG_TYPE_ATTRIB);
}

static int
write_text_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                           const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t text_count = 0;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint64_t first_column_height = 0;
  uint32_t *references;
  size_t i;
  size_t row_index = 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      if (is_text_source_object (&dwg->object[i]))
        text_count++;
    }
  if (text_count > SIZE_MAX / (6 * sizeof (uint32_t))
      || text_count > UINT32_MAX)
    {
      set_error (writer, "too many text entities for scene cache");
      return 0;
    }
  references
      = text_count
            ? (uint32_t *)malloc ((size_t)text_count * 6
                                 * sizeof (uint32_t))
            : NULL;
  if (text_count && !references)
    {
      set_error (writer, "out of memory while writing source text");
      return 0;
    }

  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      TextSource source;
      if (!is_text_source_object (&dwg->object[i]))
        continue;
      if (!read_text_source (&dwg->object[i], &source))
        {
          free (references);
          set_error (writer, "cannot decode source text as UTF-8");
          return 0;
        }
      if (!checked_string_layout (
              &string_cursor, source.value, &references[row_index * 6],
              &references[row_index * 6 + 1])
          || !checked_string_layout (
              &string_cursor, source.tag, &references[row_index * 6 + 2],
              &references[row_index * 6 + 3])
          || !checked_string_layout (
              &string_cursor, source.prompt,
              &references[row_index * 6 + 4],
              &references[row_index * 6 + 5]))
        {
          free_text_source (&source);
          free (references);
          set_error (writer, "text string table exceeds its limits");
          return 0;
        }
      free_text_source (&source);
      row_index++;
    }

  string_offset
      = STRING_TABLE_HEADER_SIZE + text_count * TEXT_ENTITY_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)text_count)
      || !write_u32 (writer, TEXT_ENTITY_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }

  row_index = 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      TextSource source;
      uint32_t style_index;
      size_t j;
      if (!is_text_source_object (&dwg->object[i]))
        continue;
      if (!read_text_source (&dwg->object[i], &source))
        {
          free (references);
          set_error (writer, "cannot decode source text as UTF-8");
          return 0;
        }
      style_index = find_handle_index (
          tables->text_style_indices, tables->text_style_count,
          reference_handle (source.style));
      if (!write_common (writer, source.object, tables)
          || !write_u16 (writer, source.kind)
          || !write_u16 (writer, source.flags)
          || !write_u32 (writer, style_index))
        goto text_row_failed;
      for (j = 0; j < 6; j++)
        {
          if (!write_u32 (writer, references[row_index * 6 + j]))
            goto text_row_failed;
        }
      if (!write_u64 (writer, source.linked_handle)
          || !write_vec3 (writer, source.insertion_point)
          || !write_vec3 (writer, source.alignment_point)
          || !write_vec3 (writer, source.normal)
          || !write_vec3 (writer, source.x_axis_direction)
          || !write_f64 (writer, source.height)
          || !write_f64 (writer, source.width_factor)
          || !write_f64 (writer, source.rotation)
          || !write_f64 (writer, source.oblique_angle)
          || !write_f64 (writer, source.thickness)
          || !write_f64 (writer, source.rectangle_width)
          || !write_f64 (writer, source.rectangle_height)
          || !write_f64 (writer, source.extents_width)
          || !write_f64 (writer, source.extents_height)
          || !write_f64 (writer, source.line_spacing_factor)
          || !write_f64 (writer, source.background_scale)
          || !write_u32 (writer, source.background_color)
          || !write_i32 (writer, source.background_transparency)
          || !write_i32 (writer, source.background_flags)
          || !write_i32 (writer, source.source_flags)
          || !write_i16 (writer, source.horizontal_alignment)
          || !write_i16 (writer, source.vertical_alignment)
          || !write_i16 (writer, source.attachment)
          || !write_i16 (writer, source.flow_direction)
          || !write_i16 (writer, source.line_spacing_style)
          || !write_i16 (writer, source.generation_flags)
          || !write_i16 (writer, source.field_length)
          || !write_i16 (writer, source.mtext_type)
          || !write_i32 (writer, source.line_count)
          || !write_i32 (writer, source.column_type)
          || !write_i32 (writer, source.column_count)
          || !write_u32 (writer, source.column_flags)
          || !write_f64 (writer, source.column_width)
          || !write_f64 (writer, source.column_gutter)
          || !write_u64 (writer, first_column_height)
          || !write_u64 (writer, source.column_height_count))
        goto text_row_failed;
      if (UINT64_MAX - first_column_height
          < source.column_height_count)
        {
          free_text_source (&source);
          free (references);
          set_error (writer, "text column-height range overflow");
          return 0;
        }
      first_column_height += source.column_height_count;
      free_text_source (&source);
      row_index++;
      continue;

    text_row_failed:
      free_text_source (&source);
      free (references);
      return 0;
    }

  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      TextSource source;
      if (!is_text_source_object (&dwg->object[i]))
        continue;
      if (!read_text_source (&dwg->object[i], &source))
        {
          free (references);
          set_error (writer, "cannot decode source text as UTF-8");
          return 0;
        }
      if (!write_bytes (writer, source.value, strlen (source.value))
          || !write_bytes (writer, source.tag, strlen (source.tag))
          || !write_bytes (writer, source.prompt,
                           strlen (source.prompt)))
        {
          free_text_source (&source);
          free (references);
          return 0;
        }
      free_text_source (&source);
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_TEXT_ENTITIES, TEXT_ENTITY_RECORD_SIZE,
      "text_entities", offset, text_count, SECTION_FLAG_STRING_TABLE);
}

static int
write_text_column_height_section (CacheWriter *writer, const Dwg_Data *dwg,
                                  SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      TextSource source;
      uint64_t column_index;
      if (!is_text_source_object (&dwg->object[i]))
        continue;
      if (!read_text_source (&dwg->object[i], &source))
        {
          set_error (writer, "cannot decode source text as UTF-8");
          return 0;
        }
      for (column_index = 0;
           column_index < source.column_height_count; column_index++)
        {
          if (!write_f64 (writer, source.column_heights[column_index]))
            {
              free_text_source (&source);
              return 0;
            }
          count++;
        }
      free_text_source (&source);
    }
  return finish_fixed_section (
      writer, entry, SECTION_TEXT_COLUMN_HEIGHTS,
      TEXT_COLUMN_HEIGHT_RECORD_SIZE, "text_column_heights", offset, count);
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
      else
        {
          uint64_t target_handle;
          if (!dimension_block_target (object, tables, &target_handle,
                                       insert_point))
            continue;
          scale[0] = 1.0;
          scale[1] = 1.0;
          scale[2] = 1.0;
          normal[0] = 0.0;
          normal[1] = 0.0;
          normal[2] = 1.0;
          if (!write_insert_record (writer, object, tables, insert_point,
                                    scale, 0.0, normal, target_handle, 1, 1,
                                    0.0, 0.0))
            return 0;
          count++;
        }
    }
  return finish_fixed_section (writer, entry, SECTION_INSERTS,
                               INSERT_RECORD_SIZE, "inserts", offset, count);
}

static int
write_polyline_header_section (CacheWriter *writer, const Dwg_Data *dwg,
                               const CacheTables *tables,
                               SectionEntry *entry)
{
  uint64_t offset;
  uint64_t first_vertex = 0;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      PolylineInfo info;
      uint64_t vertex_count;
      if (!read_polyline_info (object, &info))
        continue;
      vertex_count = polyline_vertex_count (object);
      if (vertex_count > UINT32_MAX
          || UINT64_MAX - first_vertex < vertex_count)
        {
          set_error (writer, "polyline vertex range exceeds scene cache");
          return 0;
        }
      if (!write_common (writer, object, tables)
          || !write_u64 (writer, first_vertex)
          || !write_u32 (writer, (uint32_t)vertex_count)
          || !write_u16 (writer, info.kind)
          || !write_u16 (writer, info.flags)
          || !write_f64 (writer, info.elevation)
          || !write_f64 (writer, info.thickness)
          || !write_vec3 (writer, info.normal)
          || !write_f64 (writer, info.default_start_width)
          || !write_f64 (writer, info.default_end_width)
          || !write_f64 (writer, info.constant_width))
        return 0;
      first_vertex += vertex_count;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_POLYLINE_HEADERS,
      POLYLINE_HEADER_RECORD_SIZE, "polyline_headers", offset, count);
}

static int
write_polyline_vertex_record (void *context,
                              const PolylineVertex *vertex)
{
  CacheWriter *writer = (CacheWriter *)context;
  return write_vec3 (writer, vertex->position)
         && write_f64 (writer, vertex->bulge)
         && write_f64 (writer, vertex->start_width)
         && write_f64 (writer, vertex->end_width)
         && write_f64 (writer, vertex->curve_tangent)
         && write_u32 (writer, vertex->flags)
         && write_i32 (writer, vertex->id);
}

static int
write_polyline_vertex_section (CacheWriter *writer, const Dwg_Data *dwg,
                               SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      PolylineInfo info;
      uint64_t object_count = 0;
      if (!read_polyline_info (object, &info))
        continue;
      if (!iterate_polyline_vertices (
              object, write_polyline_vertex_record, writer,
              &object_count))
        return 0;
      if (UINT64_MAX - count < object_count)
        {
          set_error (writer, "polyline vertex count overflow");
          return 0;
        }
      count += object_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_POLYLINE_VERTICES,
      POLYLINE_VERTEX_RECORD_SIZE, "polyline_vertices", offset, count);
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
write_spline_header_section (CacheWriter *writer, const Dwg_Data *dwg,
                             const CacheTables *tables,
                             SectionEntry *entry)
{
  uint64_t offset;
  uint64_t knot_index = 0;
  uint64_t weight_index = 0;
  uint64_t control_index = 0;
  uint64_t fit_index = 0;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      uint64_t knot_count;
      uint64_t weight_count;
      uint64_t control_count;
      uint64_t fit_count;
      uint32_t flags = 0;
      double normal[3] = { 0.0, 0.0, 1.0 };
      double knot_tolerance;
      double control_tolerance;
      double begin_tangent[3];
      double end_tangent[3];
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      knot_count = (uint64_t)spline_knot_count (spline);
      weight_count = (uint64_t)spline_weight_count (spline);
      control_count = (uint64_t)spline_control_point_count (spline);
      fit_count = (uint64_t)spline_fit_point_count (spline);
      if (UINT64_MAX - knot_index < knot_count
          || UINT64_MAX - weight_index < weight_count
          || UINT64_MAX - control_index < control_count
          || UINT64_MAX - fit_index < fit_count)
        {
          set_error (writer, "spline pool index overflow");
          return 0;
        }
      if (spline_is_closed (spline))
        flags |= 1u;
      if (spline->periodic)
        flags |= 1u << 1;
      if (spline->rational)
        flags |= 1u << 2;
      knot_tolerance
          = spline->scenario == SPLINE_SCENARIO_SPLINE
                ? spline->knot_tol
                : 0.0;
      control_tolerance
          = spline->scenario == SPLINE_SCENARIO_SPLINE
                ? spline->ctrl_tol
                : 0.0;
      begin_tangent[0] = spline->beg_tan_vec.x;
      begin_tangent[1] = spline->beg_tan_vec.y;
      begin_tangent[2] = spline->beg_tan_vec.z;
      end_tangent[0] = spline->end_tan_vec.x;
      end_tangent[1] = spline->end_tan_vec.y;
      end_tangent[2] = spline->end_tan_vec.z;
      if (!write_common (writer, object, tables)
          || !write_i32 (writer, (int32_t)spline->degree)
          || !write_u32 (writer, flags)
          || !write_i32 (writer, (int32_t)spline->knotparam)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, knot_index)
          || !write_u64 (writer, knot_count)
          || !write_u64 (writer, control_index)
          || !write_u64 (writer, control_count)
          || !write_u64 (writer, weight_index)
          || !write_u64 (writer, weight_count)
          || !write_u64 (writer, fit_index)
          || !write_u64 (writer, fit_count)
          || !write_vec3 (writer, normal)
          || !write_f64 (writer, knot_tolerance)
          || !write_f64 (writer, control_tolerance)
          || !write_f64 (writer, spline->fit_tol)
          || !write_vec3 (writer, begin_tangent)
          || !write_vec3 (writer, end_tangent))
        return 0;
      knot_index += knot_count;
      weight_index += weight_count;
      control_index += control_count;
      fit_index += fit_count;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_HEADERS, SPLINE_HEADER_RECORD_SIZE,
      "spline_headers", offset, count);
}

static int
write_spline_knot_section (CacheWriter *writer, const Dwg_Data *dwg,
                           SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t knot_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      knot_count = spline_knot_count (spline);
      if (UINT64_MAX - count < (uint64_t)knot_count)
        {
          set_error (writer, "spline knot count overflow");
          return 0;
        }
      for (index = 0; index < knot_count; index++)
        {
          if (!write_f64 (writer, spline->knots[index]))
            return 0;
        }
      count += (uint64_t)knot_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_KNOTS, SPLINE_SCALAR_RECORD_SIZE,
      "spline_knots", offset, count);
}

static int
write_spline_weight_section (CacheWriter *writer, const Dwg_Data *dwg,
                             SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t weight_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      weight_count = spline_weight_count (spline);
      if (UINT64_MAX - count < (uint64_t)weight_count)
        {
          set_error (writer, "spline weight count overflow");
          return 0;
        }
      for (index = 0; index < weight_count; index++)
        {
          if (!write_f64 (writer, spline->ctrl_pts[index].w))
            return 0;
        }
      count += (uint64_t)weight_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_WEIGHTS, SPLINE_SCALAR_RECORD_SIZE,
      "spline_weights", offset, count);
}

static int
write_spline_control_point_section (CacheWriter *writer,
                                    const Dwg_Data *dwg,
                                    SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t control_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      control_count = spline_control_point_count (spline);
      if (UINT64_MAX - count < (uint64_t)control_count)
        {
          set_error (writer, "spline control-point count overflow");
          return 0;
        }
      for (index = 0; index < control_count; index++)
        {
          double point[3] = { spline->ctrl_pts[index].x,
                              spline->ctrl_pts[index].y,
                              spline->ctrl_pts[index].z };
          if (!write_vec3 (writer, point))
            return 0;
        }
      count += (uint64_t)control_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_CONTROL_POINTS,
      SPLINE_POINT_RECORD_SIZE, "spline_control_points", offset, count);
}

static int
write_spline_fit_point_section (CacheWriter *writer,
                                const Dwg_Data *dwg,
                                SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t fit_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      fit_count = spline_fit_point_count (spline);
      if (UINT64_MAX - count < (uint64_t)fit_count)
        {
          set_error (writer, "spline fit-point count overflow");
          return 0;
        }
      for (index = 0; index < fit_count; index++)
        {
          double point[3] = { spline->fit_pts[index].x,
                              spline->fit_pts[index].y,
                              spline->fit_pts[index].z };
          if (!write_vec3 (writer, point))
            return 0;
        }
      count += (uint64_t)fit_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_FIT_POINTS,
      SPLINE_POINT_RECORD_SIZE, "spline_fit_points", offset, count);
}

static uint32_t
entity_group (const Dwg_Object_Entity *entity, const CacheTables *tables)
{
  uint64_t owner = entity_owner_handle (entity, tables);
  uint32_t index
      = find_handle_index (tables->block_indices, tables->block_count, owner);
  if (index != UINT32_MAX && tables->blocks
      && index < tables->block_count)
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
initialize_entity_segment (const Dwg_Object *object,
                           const CacheTables *tables, uint8_t source_kind,
                           int approximated_curve, LineSegment *segment)
{
  Dwg_Object_Entity *entity;
  int line_weight;
  if (!object || !object->tio.entity || !segment)
    return 0;
  entity = object->tio.entity;
  memset (segment, 0, sizeof (*segment));
  segment->group = entity_group (entity, tables);
  if (segment->group == UINT32_MAX - 1u)
    return 0;
  line_weight = dxf_cvt_lweight (entity->linewt);
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  segment->handle = (uint64_t)object->handle.value;
  segment->layer_index = entity_layer_index (entity, tables);
  segment->color = encode_color (&entity->color);
  segment->line_weight = (int16_t)line_weight;
  segment->flags = entity->invisible ? 1u : 0u;
  segment->source_kind = source_kind;
  segment->approximated_curve = approximated_curve ? 1u : 0u;
  return 1;
}

static int
line_segment_from_object (const Dwg_Object *object,
                          const CacheTables *tables, LineSegment *segment)
{
  Dwg_Entity_LINE *line;
  size_t axis;
  if (object->fixedtype != DWG_TYPE_LINE || !object->tio.entity
      || !(line = object->tio.entity->tio.LINE))
    return 0;
  if (!initialize_entity_segment (object, tables, 0, 0, segment))
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
segment_iteration_emit (SegmentIteration *iteration,
                        const LineSegment *segment)
{
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (segment->start[axis])
          || !isfinite (segment->end[axis]))
        {
          iteration->skipped++;
          return 1;
        }
    }
  if (segment->approximated_curve)
    iteration->approximated++;
  if (iteration->overview
      && !overview_select (iteration->overview, segment))
    return 1;
  if (!iteration->consumer (
          iteration->consumer_context, segment))
    return 0;
  iteration->emitted++;
  return 1;
}

static void
segment_iteration_reject (SegmentIteration *iteration)
{
  iteration->skipped++;
}

static unsigned
curve_segment_count (double sweep)
{
  double requested;
  if (!isfinite (sweep) || fabs (sweep) <= CURVE_EPSILON)
    return 0;
  requested = ceil (fabs (sweep) / CURVE_MAX_ANGLE_RADIANS);
  if (!isfinite (requested) || requested < 1.0)
    return 0;
  if (requested > (double)MAX_CIRCULAR_SEGMENTS)
    return MAX_CIRCULAR_SEGMENTS;
  return (unsigned)requested;
}

static int
normalized_curve_sweep (double start, double end, double *sweep)
{
  double raw;
  double normalized;
  if (!sweep || !isfinite (start) || !isfinite (end))
    return 0;
  raw = end - start;
  if (fabs (raw) >= CURVE_FULL_TURN_RADIANS - CURVE_EPSILON)
    {
      *sweep = CURVE_FULL_TURN_RADIANS;
      return 1;
    }
  normalized = fmod (raw, CURVE_FULL_TURN_RADIANS);
  if (normalized < 0.0)
    normalized += CURVE_FULL_TURN_RADIANS;
  if (!isfinite (normalized) || normalized <= CURVE_EPSILON)
    return 0;
  *sweep = normalized;
  return 1;
}

static unsigned
bulge_segment_count (double bulge)
{
  double sweep;
  unsigned requested;
  if (!isfinite (bulge) || fabs (bulge) <= CURVE_EPSILON)
    return 1;
  sweep = fabs (4.0 * atan (bulge));
  requested = curve_segment_count (sweep);
  return requested ? requested : 1u;
}

static int
bulge_point (const PolylineVertex *start, const PolylineVertex *end,
             double elevation, unsigned subdivision,
             unsigned subdivisions, double point[3])
{
  double fraction;
  double delta_x;
  double delta_y;
  double chord;
  double center_offset;
  double center_x;
  double center_y;
  double radius;
  double start_angle;
  double angle;
  if (!subdivisions || subdivision > subdivisions
      || !isfinite (start->bulge))
    return 0;
  fraction = (double)subdivision / (double)subdivisions;
  if (fabs (start->bulge) <= CURVE_EPSILON)
    {
      point[0] = start->position[0]
                 + (end->position[0] - start->position[0]) * fraction;
      point[1] = start->position[1]
                 + (end->position[1] - start->position[1]) * fraction;
      point[2] = elevation;
      return 1;
    }
  delta_x = end->position[0] - start->position[0];
  delta_y = end->position[1] - start->position[1];
  chord = hypot (delta_x, delta_y);
  if (!isfinite (chord))
    return 0;
  if (chord <= CURVE_EPSILON)
    {
      point[0] = start->position[0];
      point[1] = start->position[1];
      point[2] = elevation;
      return 1;
    }
  center_offset
      = chord * (1.0 - start->bulge * start->bulge)
        / (4.0 * start->bulge);
  center_x = (start->position[0] + end->position[0]) * 0.5
             - delta_y / chord * center_offset;
  center_y = (start->position[1] + end->position[1]) * 0.5
             + delta_x / chord * center_offset;
  radius = hypot (start->position[0] - center_x,
                  start->position[1] - center_y);
  start_angle = atan2 (start->position[1] - center_y,
                       start->position[0] - center_x);
  angle = start_angle + 4.0 * atan (start->bulge) * fraction;
  point[0] = center_x + radius * cos (angle);
  point[1] = center_y + radius * sin (angle);
  point[2] = elevation;
  return 1;
}

static void
ocs_to_wcs (const double normal[3], const double point[3],
            double transformed[3])
{
  double n[3] = { normal[0], normal[1], normal[2] };
  double x_axis[3];
  double y_axis[3];
  double length = sqrt (n[0] * n[0] + n[1] * n[1]
                        + n[2] * n[2]);
  double axis_length;
  if (!isfinite (length) || length <= 1.0e-12)
    {
      memcpy (transformed, point, 3 * sizeof (double));
      return;
    }
  n[0] /= length;
  n[1] /= length;
  n[2] /= length;
  if (fabs (n[0]) < 1.0 / 64.0 && fabs (n[1]) < 1.0 / 64.0)
    {
      x_axis[0] = n[2];
      x_axis[1] = 0.0;
      x_axis[2] = -n[0];
    }
  else
    {
      x_axis[0] = -n[1];
      x_axis[1] = n[0];
      x_axis[2] = 0.0;
    }
  axis_length = sqrt (x_axis[0] * x_axis[0]
                      + x_axis[1] * x_axis[1]
                      + x_axis[2] * x_axis[2]);
  if (!isfinite (axis_length) || axis_length <= 1.0e-12)
    {
      memcpy (transformed, point, 3 * sizeof (double));
      return;
    }
  x_axis[0] /= axis_length;
  x_axis[1] /= axis_length;
  x_axis[2] /= axis_length;
  y_axis[0] = n[1] * x_axis[2] - n[2] * x_axis[1];
  y_axis[1] = n[2] * x_axis[0] - n[0] * x_axis[2];
  y_axis[2] = n[0] * x_axis[1] - n[1] * x_axis[0];
  transformed[0] = x_axis[0] * point[0] + y_axis[0] * point[1]
                   + n[0] * point[2];
  transformed[1] = x_axis[1] * point[0] + y_axis[1] * point[1]
                   + n[1] * point[2];
  transformed[2] = x_axis[2] * point[0] + y_axis[2] * point[1]
                   + n[2] * point[2];
}

typedef struct
{
  const Dwg_Object *object;
  const CacheTables *tables;
  const PolylineInfo *info;
  SegmentIteration *iteration;
  PolylineVertex first;
  PolylineVertex previous;
  uint64_t count;
  int has_previous;
} PolylineSegmentBuilder;

static void
initialize_polyline_segment (const PolylineSegmentBuilder *builder,
                             LineSegment *segment)
{
  const Dwg_Object_Entity *entity = builder->object->tio.entity;
  int line_weight = dxf_cvt_lweight (entity->linewt);
  memset (segment, 0, sizeof (*segment));
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  segment->handle = (uint64_t)builder->object->handle.value;
  segment->layer_index = entity_layer_index (entity, builder->tables);
  segment->color = encode_color (&entity->color);
  segment->line_weight = (int16_t)line_weight;
  segment->flags = entity->invisible ? 1u : 0u;
  segment->group = entity_group (entity, builder->tables);
  segment->source_kind = (uint8_t)builder->info->kind;
}

static int
emit_polyline_edge (PolylineSegmentBuilder *builder,
                    const PolylineVertex *start,
                    const PolylineVertex *end)
{
  unsigned subdivisions
      = builder->info->kind == 3
            ? 1u
            : bulge_segment_count (start->bulge);
  unsigned index;
  for (index = 0; index < subdivisions; index++)
    {
      LineSegment segment;
      initialize_polyline_segment (builder, &segment);
      if (builder->info->kind == 3)
        {
          memcpy (segment.start, start->position,
                  3 * sizeof (double));
          memcpy (segment.end, end->position, 3 * sizeof (double));
        }
      else
        {
          double start_ocs[3];
          double end_ocs[3];
          if (!bulge_point (start, end, builder->info->elevation,
                            index, subdivisions, start_ocs)
              || !bulge_point (start, end, builder->info->elevation,
                               index + 1u, subdivisions, end_ocs))
            {
              segment_iteration_reject (builder->iteration);
              continue;
            }
          ocs_to_wcs (builder->info->normal, start_ocs,
                      segment.start);
          ocs_to_wcs (builder->info->normal, end_ocs, segment.end);
          segment.approximated_curve
              = isfinite (start->bulge)
                && fabs (start->bulge) > CURVE_EPSILON;
        }
      if (!segment_iteration_emit (builder->iteration, &segment))
        return 0;
    }
  return 1;
}

static int
polyline_segment_vertex (void *context, const PolylineVertex *vertex)
{
  PolylineSegmentBuilder *builder
      = (PolylineSegmentBuilder *)context;
  if (!builder->has_previous)
    {
      builder->first = *vertex;
      builder->previous = *vertex;
      builder->has_previous = 1;
    }
  else
    {
      if (!emit_polyline_edge (builder, &builder->previous, vertex))
        return 0;
      builder->previous = *vertex;
    }
  builder->count++;
  return 1;
}

static int
iterate_polyline_segments (const Dwg_Object *object,
                           const CacheTables *tables,
                           SegmentIteration *iteration)
{
  PolylineInfo info;
  PolylineSegmentBuilder builder;
  if (!read_polyline_info (object, &info))
    return 1;
  if (entity_group (object->tio.entity, tables) == UINT32_MAX - 1u)
    return 1;
  memset (&builder, 0, sizeof (builder));
  builder.object = object;
  builder.tables = tables;
  builder.info = &info;
  builder.iteration = iteration;
  if (!iterate_polyline_vertices (
          object, polyline_segment_vertex, &builder, NULL))
    return 0;
  if (info.closed && builder.count > 1
      && !emit_polyline_edge (
          &builder, &builder.previous, &builder.first))
    return 0;
  return 1;
}

static void
circular_ocs_point (const double center[3], double radius, double angle,
                    const double normal[3], double point[3])
{
  double ocs_point[3];
  ocs_point[0] = center[0] + radius * cos (angle);
  ocs_point[1] = center[1] + radius * sin (angle);
  ocs_point[2] = center[2];
  ocs_to_wcs (normal, ocs_point, point);
}

static int
ellipse_axes (const double major_axis[3], const double normal[3],
              double axis_ratio, double minor_axis[3])
{
  double major_length;
  double normal_length_squared;
  double normal_length;
  double unit_normal[3];
  double cross[3];
  double cross_length;
  double minor_length;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (major_axis[axis]) || !isfinite (normal[axis]))
        return 0;
    }
  if (!isfinite (axis_ratio) || fabs (axis_ratio) <= CURVE_EPSILON)
    return 0;
  major_length
      = hypot (hypot (major_axis[0], major_axis[1]), major_axis[2]);
  normal_length_squared = normal[0] * normal[0]
                          + normal[1] * normal[1]
                          + normal[2] * normal[2];
  if (!isfinite (major_length) || major_length <= CURVE_EPSILON
      || !isfinite (normal_length_squared)
      || normal_length_squared <= CURVE_EPSILON)
    return 0;
  normal_length = sqrt (normal_length_squared);
  unit_normal[0] = normal[0] / normal_length;
  unit_normal[1] = normal[1] / normal_length;
  unit_normal[2] = normal[2] / normal_length;
  cross[0] = unit_normal[1] * major_axis[2]
             - unit_normal[2] * major_axis[1];
  cross[1] = unit_normal[2] * major_axis[0]
             - unit_normal[0] * major_axis[2];
  cross[2] = unit_normal[0] * major_axis[1]
             - unit_normal[1] * major_axis[0];
  cross_length = hypot (hypot (cross[0], cross[1]), cross[2]);
  minor_length = major_length * fabs (axis_ratio);
  if (!isfinite (cross_length) || cross_length <= CURVE_EPSILON
      || !isfinite (minor_length))
    return 0;
  minor_axis[0] = cross[0] / cross_length * minor_length;
  minor_axis[1] = cross[1] / cross_length * minor_length;
  minor_axis[2] = cross[2] / cross_length * minor_length;
  return 1;
}

static void
ellipse_point (const double center[3], const double major_axis[3],
               const double minor_axis[3], double parameter,
               double point[3])
{
  double major_scale = cos (parameter);
  double minor_scale = sin (parameter);
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    point[axis] = center[axis] + major_axis[axis] * major_scale
                  + minor_axis[axis] * minor_scale;
}

static int
iterate_analytic_curve_segments (const Dwg_Object *object,
                                 const CacheTables *tables,
                                 SegmentIteration *iteration)
{
  LineSegment base;
  double center[3];
  double normal[3];
  double major_axis[3];
  double minor_axis[3];
  double start_parameter;
  double sweep;
  double radius;
  unsigned segment_count;
  unsigned index;
  if (!object || !object->tio.entity)
    return 1;
  if (object->fixedtype == DWG_TYPE_ARC
      && object->tio.entity->tio.ARC)
    {
      const Dwg_Entity_ARC *arc = object->tio.entity->tio.ARC;
      radius = arc->radius;
      start_parameter = arc->start_angle;
      if (!isfinite (radius) || fabs (radius) <= CURVE_EPSILON
          || !normalized_curve_sweep (
              start_parameter, arc->end_angle, &sweep))
        return 1;
      center[0] = arc->center.x;
      center[1] = arc->center.y;
      center[2] = arc->center.z;
      normal[0] = arc->extrusion.x;
      normal[1] = arc->extrusion.y;
      normal[2] = arc->extrusion.z;
      if (!initialize_entity_segment (object, tables, 4, 1, &base))
        return 1;
      segment_count = curve_segment_count (sweep);
      for (index = 0; index < segment_count; index++)
        {
          LineSegment segment = base;
          double start_angle
              = start_parameter
                + sweep * (double)index / (double)segment_count;
          double end_angle
              = start_parameter
                + sweep * (double)(index + 1u)
                      / (double)segment_count;
          circular_ocs_point (center, radius, start_angle, normal,
                              segment.start);
          circular_ocs_point (center, radius, end_angle, normal,
                              segment.end);
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_CIRCLE
      && object->tio.entity->tio.CIRCLE)
    {
      const Dwg_Entity_CIRCLE *circle
          = object->tio.entity->tio.CIRCLE;
      radius = circle->radius;
      if (!isfinite (radius) || fabs (radius) <= CURVE_EPSILON)
        return 1;
      center[0] = circle->center.x;
      center[1] = circle->center.y;
      center[2] = circle->center.z;
      normal[0] = circle->extrusion.x;
      normal[1] = circle->extrusion.y;
      normal[2] = circle->extrusion.z;
      if (!initialize_entity_segment (object, tables, 5, 1, &base))
        return 1;
      segment_count = curve_segment_count (CURVE_FULL_TURN_RADIANS);
      for (index = 0; index < segment_count; index++)
        {
          LineSegment segment = base;
          double start_angle
              = CURVE_FULL_TURN_RADIANS * (double)index
                / (double)segment_count;
          double end_angle
              = CURVE_FULL_TURN_RADIANS * (double)(index + 1u)
                / (double)segment_count;
          circular_ocs_point (center, radius, start_angle, normal,
                              segment.start);
          circular_ocs_point (center, radius, end_angle, normal,
                              segment.end);
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_ELLIPSE
      && object->tio.entity->tio.ELLIPSE)
    {
      const Dwg_Entity_ELLIPSE *ellipse
          = object->tio.entity->tio.ELLIPSE;
      center[0] = ellipse->center.x;
      center[1] = ellipse->center.y;
      center[2] = ellipse->center.z;
      major_axis[0] = ellipse->sm_axis.x;
      major_axis[1] = ellipse->sm_axis.y;
      major_axis[2] = ellipse->sm_axis.z;
      normal[0] = ellipse->extrusion.x;
      normal[1] = ellipse->extrusion.y;
      normal[2] = ellipse->extrusion.z;
      start_parameter = ellipse->start_angle;
      if (!ellipse_axes (major_axis, normal, ellipse->axis_ratio,
                         minor_axis)
          || !normalized_curve_sweep (
              start_parameter, ellipse->end_angle, &sweep))
        return 1;
      if (!initialize_entity_segment (object, tables, 6, 1, &base))
        return 1;
      segment_count = curve_segment_count (sweep);
      for (index = 0; index < segment_count; index++)
        {
          LineSegment segment = base;
          double start
              = start_parameter
                + sweep * (double)index / (double)segment_count;
          double end
              = start_parameter
                + sweep * (double)(index + 1u)
                      / (double)segment_count;
          ellipse_point (center, major_axis, minor_axis, start,
                         segment.start);
          ellipse_point (center, major_axis, minor_axis, end,
                         segment.end);
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
    }
  return 1;
}

static int
read_spline_sampling (const Dwg_Entity_SPLINE *spline,
                      SplineSampling *sampling)
{
  size_t degree;
  size_t control_count;
  size_t knot_count;
  size_t required_knots;
  size_t nonzero_spans = 0;
  size_t requested_segments;
  size_t index;
  int has_nonzero_weight = 0;
  double domain_range;
  if (!spline || !sampling || spline->degree <= 0
      || (uint64_t)spline->degree > MAX_SPLINE_DEGREE)
    return 0;
  degree = (size_t)spline->degree;
  control_count = spline_control_point_count (spline);
  knot_count = spline_knot_count (spline);
  if (control_count <= degree
      || control_count > SIZE_MAX - degree - 1u)
    return 0;
  required_knots = control_count + degree + 1u;
  if (knot_count < required_knots)
    return 0;
  for (index = 0; index < knot_count; index++)
    {
      if (!isfinite (spline->knots[index])
          || (index && spline->knots[index - 1u]
                           > spline->knots[index]))
        return 0;
    }
  if (spline->weighted)
    {
      for (index = 0; index < control_count; index++)
        {
          double weight = spline->ctrl_pts[index].w;
          if (!isfinite (weight))
            return 0;
          if (fabs (weight) > CURVE_EPSILON)
            has_nonzero_weight = 1;
        }
      if (!has_nonzero_weight)
        return 0;
    }
  sampling->domain_start = spline->knots[degree];
  sampling->domain_end = spline->knots[control_count];
  domain_range = sampling->domain_end - sampling->domain_start;
  if (!isfinite (domain_range) || domain_range <= CURVE_EPSILON)
    return 0;
  for (index = degree; index < control_count; index++)
    {
      double span = spline->knots[index + 1u] - spline->knots[index];
      if (!isfinite (span))
        return 0;
      if (span > CURVE_EPSILON)
        nonzero_spans++;
    }
  if (!nonzero_spans)
    return 0;
  sampling->segments_per_span
      = degree == 1u ? 1u : SPLINE_SEGMENTS_PER_SPAN;
  if (nonzero_spans > SIZE_MAX / sampling->segments_per_span)
    return 0;
  requested_segments
      = nonzero_spans * sampling->segments_per_span;
  sampling->degree = degree;
  sampling->control_count = control_count;
  sampling->nonzero_spans = nonzero_spans;
  sampling->segment_count
      = requested_segments > MAX_SPLINE_SEGMENTS
            ? MAX_SPLINE_SEGMENTS
            : (unsigned)requested_segments;
  sampling->uniform_domain
      = requested_segments > MAX_SPLINE_SEGMENTS;
  return sampling->segment_count != 0;
}

static int
spline_segment_parameters (const Dwg_Entity_SPLINE *spline,
                           const SplineSampling *sampling,
                           unsigned segment_index, double *start,
                           double *end)
{
  size_t span_ordinal;
  size_t subdivision;
  size_t current_span = 0;
  size_t knot_index;
  if (!spline || !sampling || !start || !end
      || segment_index >= sampling->segment_count)
    return 0;
  if (sampling->uniform_domain)
    {
      double scale
          = (sampling->domain_end - sampling->domain_start)
            / (double)sampling->segment_count;
      *start = sampling->domain_start
               + scale * (double)segment_index;
      *end = sampling->domain_start
             + scale * (double)(segment_index + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  span_ordinal
      = (size_t)segment_index / sampling->segments_per_span;
  subdivision
      = (size_t)segment_index % sampling->segments_per_span;
  if (span_ordinal >= sampling->nonzero_spans)
    return 0;
  for (knot_index = sampling->degree;
       knot_index < sampling->control_count; knot_index++)
    {
      double span_start = spline->knots[knot_index];
      double span_end = spline->knots[knot_index + 1u];
      double scale;
      if (span_end - span_start <= CURVE_EPSILON)
        continue;
      if (current_span++ != span_ordinal)
        continue;
      scale
          = (span_end - span_start)
            / (double)sampling->segments_per_span;
      *start = span_start + scale * (double)subdivision;
      *end = span_start + scale * (double)(subdivision + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  return 0;
}

static int
evaluate_spline (const Dwg_Entity_SPLINE *spline,
                 const SplineSampling *sampling, double parameter,
                 double point[3])
{
  double points[MAX_SPLINE_DEGREE + 1u][3];
  double weights[MAX_SPLINE_DEGREE + 1u];
  size_t span = SIZE_MAX;
  size_t level;
  size_t index;
  size_t axis;
  if (!spline || !sampling || !point || !isfinite (parameter))
    return 0;
  if (parameter >= sampling->domain_end - CURVE_EPSILON)
    span = sampling->control_count - 1u;
  else
    {
      for (index = sampling->degree;
           index < sampling->control_count; index++)
        {
          if (spline->knots[index] <= parameter
              && parameter < spline->knots[index + 1u])
            {
              span = index;
              break;
            }
        }
    }
  if (span == SIZE_MAX || span < sampling->degree)
    return 0;
  for (index = 0; index <= sampling->degree; index++)
    {
      size_t control_index = span - sampling->degree + index;
      const Dwg_SPLINE_control_point *control
          = &spline->ctrl_pts[control_index];
      double weight = spline->weighted ? control->w : 1.0;
      if (!isfinite (control->x) || !isfinite (control->y)
          || !isfinite (control->z) || !isfinite (weight))
        return 0;
      points[index][0] = control->x * weight;
      points[index][1] = control->y * weight;
      points[index][2] = control->z * weight;
      weights[index] = weight;
    }
  for (level = 1; level <= sampling->degree; level++)
    {
      for (index = sampling->degree; index >= level; index--)
        {
          size_t knot_index
              = span - sampling->degree + index;
          double denominator
              = spline->knots[knot_index + sampling->degree - level
                              + 1u]
                - spline->knots[knot_index];
          double alpha;
          if (fabs (denominator) <= CURVE_EPSILON)
            alpha = 0.0;
          else
            {
              alpha
                  = (parameter - spline->knots[knot_index])
                    / denominator;
              if (alpha < 0.0)
                alpha = 0.0;
              else if (alpha > 1.0)
                alpha = 1.0;
            }
          for (axis = 0; axis < 3; axis++)
            points[index][axis]
                = points[index - 1u][axis] * (1.0 - alpha)
                  + points[index][axis] * alpha;
          weights[index]
              = weights[index - 1u] * (1.0 - alpha)
                + weights[index] * alpha;
        }
    }
  if (!isfinite (weights[sampling->degree])
      || fabs (weights[sampling->degree]) <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 3; axis++)
    point[axis]
        = points[sampling->degree][axis]
          / weights[sampling->degree];
  return 1;
}

static int
spline_fallback_point (const Dwg_Entity_SPLINE *spline,
                       int use_fit_points, size_t index,
                       double point[3])
{
  if (!spline || !point)
    return 0;
  if (use_fit_points)
    {
      size_t count = spline_fit_point_count (spline);
      if (index >= count)
        return 0;
      point[0] = spline->fit_pts[index].x;
      point[1] = spline->fit_pts[index].y;
      point[2] = spline->fit_pts[index].z;
    }
  else
    {
      size_t count = spline_control_point_count (spline);
      if (index >= count)
        return 0;
      point[0] = spline->ctrl_pts[index].x;
      point[1] = spline->ctrl_pts[index].y;
      point[2] = spline->ctrl_pts[index].z;
    }
  return 1;
}

static unsigned
spline_fallback_segment_count (const Dwg_Entity_SPLINE *spline)
{
  size_t fit_count = spline_fit_point_count (spline);
  size_t point_count
      = fit_count >= 2u ? fit_count
                        : spline_control_point_count (spline);
  size_t source_segments;
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (spline_is_closed (spline) ? 1u : 0u);
  return source_segments > MAX_SPLINE_SEGMENTS
             ? MAX_SPLINE_SEGMENTS
             : (unsigned)source_segments;
}

static int
spline_fallback_segment (const Dwg_Entity_SPLINE *spline,
                         unsigned segment_index, double start[3],
                         double end[3])
{
  size_t fit_count = spline_fit_point_count (spline);
  int use_fit_points = fit_count >= 2u;
  size_t point_count
      = use_fit_points ? fit_count
                       : spline_control_point_count (spline);
  size_t source_segments;
  unsigned output_segments;
  size_t start_index;
  size_t end_index;
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (spline_is_closed (spline) ? 1u : 0u);
  output_segments
      = source_segments > MAX_SPLINE_SEGMENTS
            ? MAX_SPLINE_SEGMENTS
            : (unsigned)source_segments;
  if (!output_segments || segment_index >= output_segments)
    return 0;
  start_index
      = (size_t)((uint64_t)segment_index * source_segments
                 / output_segments);
  end_index
      = (size_t)((uint64_t)(segment_index + 1u) * source_segments
                 / output_segments);
  start_index %= point_count;
  end_index %= point_count;
  return spline_fallback_point (
             spline, use_fit_points, start_index, start)
         && spline_fallback_point (
             spline, use_fit_points, end_index, end);
}

static int
iterate_spline_segments (const Dwg_Object *object,
                         const CacheTables *tables,
                         SegmentIteration *iteration)
{
  const Dwg_Entity_SPLINE *spline;
  SplineSampling sampling;
  LineSegment base;
  unsigned index;
  if (!object || object->fixedtype != DWG_TYPE_SPLINE
      || !object->tio.entity
      || !(spline = object->tio.entity->tio.SPLINE))
    return 1;
  if (!initialize_entity_segment (object, tables, 7, 1, &base))
    return 1;
  memset (&sampling, 0, sizeof (sampling));
  if (read_spline_sampling (spline, &sampling))
    {
      base.approximated_curve = sampling.degree > 1u ? 1u : 0u;
      for (index = 0; index < sampling.segment_count; index++)
        {
          LineSegment segment = base;
          double start_parameter;
          double end_parameter;
          if (!spline_segment_parameters (
                  spline, &sampling, index, &start_parameter,
                  &end_parameter)
              || !evaluate_spline (
                  spline, &sampling, start_parameter, segment.start)
              || !evaluate_spline (
                  spline, &sampling, end_parameter, segment.end))
            {
              segment_iteration_reject (iteration);
              continue;
            }
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
      return 1;
    }
  {
    unsigned output_segments
        = spline_fallback_segment_count (spline);
    for (index = 0; index < output_segments; index++)
      {
        LineSegment segment = base;
        if (!spline_fallback_segment (
                spline, index, segment.start, segment.end))
          {
            segment_iteration_reject (iteration);
            continue;
          }
        if (!segment_iteration_emit (iteration, &segment))
          return 0;
      }
  }
  return 1;
}

static int
hatch_curve_parameters (double start, double end, int is_ccw,
                        double *first, double *sweep)
{
  if (is_ccw)
    {
      *first = start;
      return normalized_curve_sweep (start, end, sweep);
    }
  *first = end;
  return normalized_curve_sweep (end, start, sweep);
}

static int
read_hatch_spline_sampling (const Dwg_HATCH_PathSeg *segment,
                            SplineSampling *sampling)
{
  size_t degree;
  size_t control_count;
  size_t knot_count;
  size_t required_knots;
  size_t nonzero_spans = 0;
  size_t requested_segments;
  size_t index;
  int has_nonzero_weight = 0;
  double domain_range;
  if (!segment || !sampling || segment->degree <= 0
      || (uint64_t)segment->degree > MAX_SPLINE_DEGREE
      || !segment->control_points || !segment->knots)
    return 0;
  degree = (size_t)segment->degree;
  control_count = (size_t)segment->num_control_points;
  knot_count = (size_t)segment->num_knots;
  if (control_count <= degree
      || control_count > SIZE_MAX - degree - 1u)
    return 0;
  required_knots = control_count + degree + 1u;
  if (knot_count < required_knots)
    return 0;
  for (index = 0; index < knot_count; index++)
    {
      if (!isfinite (segment->knots[index])
          || (index
              && segment->knots[index - 1u]
                     > segment->knots[index]))
        return 0;
    }
  for (index = 0; index < control_count; index++)
    {
      const Dwg_HATCH_ControlPoint *control
          = &segment->control_points[index];
      if (!isfinite (control->point.x)
          || !isfinite (control->point.y)
          || !isfinite (control->weight))
        return 0;
      if (fabs (control->weight) > CURVE_EPSILON)
        has_nonzero_weight = 1;
    }
  if (segment->is_rational && !has_nonzero_weight)
    return 0;
  sampling->domain_start = segment->knots[degree];
  sampling->domain_end = segment->knots[control_count];
  domain_range = sampling->domain_end - sampling->domain_start;
  if (!isfinite (domain_range) || domain_range <= CURVE_EPSILON)
    return 0;
  for (index = degree; index < control_count; index++)
    {
      double span
          = segment->knots[index + 1u] - segment->knots[index];
      if (!isfinite (span))
        return 0;
      if (span > CURVE_EPSILON)
        nonzero_spans++;
    }
  if (!nonzero_spans)
    return 0;
  sampling->segments_per_span
      = degree == 1u ? 1u : SPLINE_SEGMENTS_PER_SPAN;
  if (nonzero_spans > SIZE_MAX / sampling->segments_per_span)
    return 0;
  requested_segments
      = nonzero_spans * sampling->segments_per_span;
  sampling->degree = degree;
  sampling->control_count = control_count;
  sampling->nonzero_spans = nonzero_spans;
  sampling->segment_count
      = requested_segments > MAX_SPLINE_SEGMENTS
            ? MAX_SPLINE_SEGMENTS
            : (unsigned)requested_segments;
  sampling->uniform_domain
      = requested_segments > MAX_SPLINE_SEGMENTS;
  return sampling->segment_count != 0;
}

static int
hatch_spline_segment_parameters (
    const Dwg_HATCH_PathSeg *segment,
    const SplineSampling *sampling, unsigned segment_index,
    double *start, double *end)
{
  size_t span_ordinal;
  size_t subdivision;
  size_t current_span = 0;
  size_t knot_index;
  if (!segment || !sampling || !start || !end
      || segment_index >= sampling->segment_count)
    return 0;
  if (sampling->uniform_domain)
    {
      double scale
          = (sampling->domain_end - sampling->domain_start)
            / (double)sampling->segment_count;
      *start = sampling->domain_start
               + scale * (double)segment_index;
      *end = sampling->domain_start
             + scale * (double)(segment_index + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  span_ordinal
      = (size_t)segment_index / sampling->segments_per_span;
  subdivision
      = (size_t)segment_index % sampling->segments_per_span;
  if (span_ordinal >= sampling->nonzero_spans)
    return 0;
  for (knot_index = sampling->degree;
       knot_index < sampling->control_count; knot_index++)
    {
      double span_start = segment->knots[knot_index];
      double span_end = segment->knots[knot_index + 1u];
      double scale;
      if (span_end - span_start <= CURVE_EPSILON)
        continue;
      if (current_span++ != span_ordinal)
        continue;
      scale
          = (span_end - span_start)
            / (double)sampling->segments_per_span;
      *start = span_start + scale * (double)subdivision;
      *end = span_start + scale * (double)(subdivision + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  return 0;
}

static int
evaluate_hatch_spline (const Dwg_HATCH_PathSeg *segment,
                       const SplineSampling *sampling,
                       double parameter, double elevation,
                       double point[3])
{
  double points[MAX_SPLINE_DEGREE + 1u][3];
  double weights[MAX_SPLINE_DEGREE + 1u];
  size_t span = SIZE_MAX;
  size_t level;
  size_t index;
  size_t axis;
  if (!segment || !sampling || !point || !isfinite (parameter)
      || !isfinite (elevation))
    return 0;
  if (parameter >= sampling->domain_end - CURVE_EPSILON)
    span = sampling->control_count - 1u;
  else
    {
      for (index = sampling->degree;
           index < sampling->control_count; index++)
        {
          if (segment->knots[index] <= parameter
              && parameter < segment->knots[index + 1u])
            {
              span = index;
              break;
            }
        }
    }
  if (span == SIZE_MAX || span < sampling->degree)
    return 0;
  for (index = 0; index <= sampling->degree; index++)
    {
      size_t control_index
          = span - sampling->degree + index;
      const Dwg_HATCH_ControlPoint *control
          = &segment->control_points[control_index];
      double weight
          = segment->is_rational ? control->weight : 1.0;
      if (!isfinite (control->point.x)
          || !isfinite (control->point.y)
          || !isfinite (weight))
        return 0;
      points[index][0] = control->point.x * weight;
      points[index][1] = control->point.y * weight;
      points[index][2] = elevation * weight;
      weights[index] = weight;
    }
  for (level = 1; level <= sampling->degree; level++)
    {
      for (index = sampling->degree; index >= level; index--)
        {
          size_t knot_index
              = span - sampling->degree + index;
          double denominator
              = segment
                    ->knots[knot_index + sampling->degree - level
                            + 1u]
                - segment->knots[knot_index];
          double alpha;
          if (fabs (denominator) <= CURVE_EPSILON)
            alpha = 0.0;
          else
            {
              alpha
                  = (parameter - segment->knots[knot_index])
                    / denominator;
              if (alpha < 0.0)
                alpha = 0.0;
              else if (alpha > 1.0)
                alpha = 1.0;
            }
          for (axis = 0; axis < 3; axis++)
            points[index][axis]
                = points[index - 1u][axis] * (1.0 - alpha)
                  + points[index][axis] * alpha;
          weights[index]
              = weights[index - 1u] * (1.0 - alpha)
                + weights[index] * alpha;
        }
    }
  if (!isfinite (weights[sampling->degree])
      || fabs (weights[sampling->degree]) <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 3; axis++)
    point[axis]
        = points[sampling->degree][axis]
          / weights[sampling->degree];
  return 1;
}

static size_t
hatch_spline_fallback_point_count (
    const Dwg_HATCH_PathSeg *segment, int *use_fit_points)
{
  size_t fit_count;
  size_t control_count;
  if (!segment)
    return 0;
  fit_count = segment->fitpts
                  ? (size_t)segment->num_fitpts
                  : 0;
  control_count = segment->control_points
                      ? (size_t)segment->num_control_points
                      : 0;
  *use_fit_points = fit_count >= 2u;
  return *use_fit_points ? fit_count : control_count;
}

static unsigned
hatch_spline_fallback_segment_count (
    const Dwg_HATCH_PathSeg *segment)
{
  int use_fit_points;
  size_t point_count = hatch_spline_fallback_point_count (
      segment, &use_fit_points);
  size_t source_segments;
  (void)use_fit_points;
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (segment->is_periodic ? 1u : 0u);
  return source_segments > MAX_SPLINE_SEGMENTS
             ? MAX_SPLINE_SEGMENTS
             : (unsigned)source_segments;
}

static int
hatch_spline_fallback_point (
    const Dwg_HATCH_PathSeg *segment, int use_fit_points,
    size_t index, double elevation, double point[3])
{
  if (use_fit_points)
    {
      if (!segment->fitpts
          || index >= (size_t)segment->num_fitpts)
        return 0;
      point[0] = segment->fitpts[index].x;
      point[1] = segment->fitpts[index].y;
    }
  else
    {
      if (!segment->control_points
          || index >= (size_t)segment->num_control_points)
        return 0;
      point[0] = segment->control_points[index].point.x;
      point[1] = segment->control_points[index].point.y;
    }
  point[2] = elevation;
  return 1;
}

static int
hatch_spline_fallback_segment (
    const Dwg_HATCH_PathSeg *segment, unsigned segment_index,
    double elevation, double start[3], double end[3])
{
  int use_fit_points;
  size_t point_count = hatch_spline_fallback_point_count (
      segment, &use_fit_points);
  size_t source_segments;
  unsigned output_segments;
  size_t start_index;
  size_t end_index;
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (segment->is_periodic ? 1u : 0u);
  output_segments
      = source_segments > MAX_SPLINE_SEGMENTS
            ? MAX_SPLINE_SEGMENTS
            : (unsigned)source_segments;
  if (!output_segments || segment_index >= output_segments)
    return 0;
  start_index
      = (size_t)((uint64_t)segment_index * source_segments
                 / output_segments)
        % point_count;
  end_index
      = (size_t)((uint64_t)(segment_index + 1u)
                     * source_segments
                 / output_segments)
        % point_count;
  return hatch_spline_fallback_point (
             segment, use_fit_points, start_index, elevation, start)
         && hatch_spline_fallback_point (
             segment, use_fit_points, end_index, elevation, end);
}

static int
emit_hatch_ocs_segment (SegmentIteration *iteration,
                        const LineSegment *base,
                        const double normal[3],
                        const double start_ocs[3],
                        const double end_ocs[3],
                        int approximated_curve,
                        uint64_t *generated)
{
  LineSegment segment = *base;
  if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
    return 1;
  ocs_to_wcs (normal, start_ocs, segment.start);
  ocs_to_wcs (normal, end_ocs, segment.end);
  segment.approximated_curve
      = approximated_curve ? 1u : 0u;
  (*generated)++;
  return segment_iteration_emit (iteration, &segment);
}

static int
iterate_hatch_polyline_path (
    const Dwg_HATCH_Path *path, double elevation,
    const double normal[3], const LineSegment *base,
    SegmentIteration *iteration, uint64_t *generated)
{
  size_t count;
  size_t source_index;
  size_t source_segments;
  if (!path || !path->polyline_paths
      || !path->num_segs_or_paths)
    return 1;
  count = (size_t)path->num_segs_or_paths;
  source_segments
      = count > 1u
            ? count - 1u + (path->closed ? 1u : 0u)
            : 0u;
  for (source_index = 0; source_index < source_segments;
       source_index++)
    {
      const Dwg_HATCH_PolylinePath *start
          = &path->polyline_paths[source_index];
      const Dwg_HATCH_PolylinePath *end
          = &path->polyline_paths[(source_index + 1u) % count];
      PolylineVertex start_vertex;
      PolylineVertex end_vertex;
      double bulge
          = path->bulges_present ? start->bulge : 0.0;
      unsigned subdivisions = bulge_segment_count (bulge);
      unsigned subdivision;
      memset (&start_vertex, 0, sizeof (start_vertex));
      memset (&end_vertex, 0, sizeof (end_vertex));
      start_vertex.position[0] = start->point.x;
      start_vertex.position[1] = start->point.y;
      start_vertex.position[2] = elevation;
      start_vertex.bulge = bulge;
      end_vertex.position[0] = end->point.x;
      end_vertex.position[1] = end->point.y;
      end_vertex.position[2] = elevation;
      for (subdivision = 0; subdivision < subdivisions;
           subdivision++)
        {
          double start_ocs[3];
          double end_ocs[3];
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          if (!bulge_point (
                  &start_vertex, &end_vertex, elevation, subdivision,
                  subdivisions, start_ocs)
              || !bulge_point (
                  &start_vertex, &end_vertex, elevation,
                  subdivision + 1u, subdivisions, end_ocs))
            {
              segment_iteration_reject (iteration);
              continue;
            }
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start_ocs, end_ocs,
                  isfinite (bulge)
                      && fabs (bulge) > CURVE_EPSILON,
                  generated))
            return 0;
        }
    }
  return 1;
}

static int
iterate_hatch_edge (
    const Dwg_HATCH_PathSeg *edge, double elevation,
    const double normal[3], const LineSegment *base,
    SegmentIteration *iteration, uint64_t *generated)
{
  if (!edge || *generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
    return 1;
  if (edge->curve_type == 1u)
    {
      double start[3]
          = { edge->first_endpoint.x, edge->first_endpoint.y,
              elevation };
      double end[3]
          = { edge->second_endpoint.x,
              edge->second_endpoint.y, elevation };
      return emit_hatch_ocs_segment (
          iteration, base, normal, start, end, 0, generated);
    }
  if (edge->curve_type == 2u)
    {
      double first;
      double sweep;
      unsigned count;
      unsigned index;
      if (!isfinite (edge->radius)
          || fabs (edge->radius) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 1;
      count = curve_segment_count (sweep);
      for (index = 0; index < count; index++)
        {
          double start_angle
              = first + sweep * (double)index / (double)count;
          double end_angle
              = first
                + sweep * (double)(index + 1u) / (double)count;
          double start[3]
              = { edge->center.x
                      + edge->radius * cos (start_angle),
                  edge->center.y
                      + edge->radius * sin (start_angle),
                  elevation };
          double end[3]
              = { edge->center.x
                      + edge->radius * cos (end_angle),
                  edge->center.y
                      + edge->radius * sin (end_angle),
                  elevation };
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start, end, 1,
                  generated))
            return 0;
        }
      return 1;
    }
  if (edge->curve_type == 3u)
    {
      double first;
      double sweep;
      double major[3]
          = { edge->endpoint.x, edge->endpoint.y, 0.0 };
      double major_length = hypot (major[0], major[1]);
      double minor[3];
      double center[3]
          = { edge->center.x, edge->center.y, elevation };
      unsigned count;
      unsigned index;
      if (!isfinite (major_length)
          || major_length <= CURVE_EPSILON
          || !isfinite (edge->minor_major_ratio)
          || fabs (edge->minor_major_ratio) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 1;
      minor[0] = -major[1] * fabs (edge->minor_major_ratio);
      minor[1] = major[0] * fabs (edge->minor_major_ratio);
      minor[2] = 0.0;
      count = curve_segment_count (sweep);
      for (index = 0; index < count; index++)
        {
          double start_parameter
              = first + sweep * (double)index / (double)count;
          double end_parameter
              = first
                + sweep * (double)(index + 1u) / (double)count;
          double start[3];
          double end[3];
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          ellipse_point (
              center, major, minor, start_parameter, start);
          ellipse_point (
              center, major, minor, end_parameter, end);
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start, end, 1,
                  generated))
            return 0;
        }
      return 1;
    }
  if (edge->curve_type == 4u)
    {
      SplineSampling sampling;
      unsigned count;
      unsigned index;
      memset (&sampling, 0, sizeof (sampling));
      if (read_hatch_spline_sampling (edge, &sampling))
        {
          count = sampling.segment_count;
          for (index = 0; index < count; index++)
            {
              double start_parameter;
              double end_parameter;
              double start[3];
              double end[3];
              if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
                return 1;
              if (!hatch_spline_segment_parameters (
                      edge, &sampling, index, &start_parameter,
                      &end_parameter)
                  || !evaluate_hatch_spline (
                      edge, &sampling, start_parameter, elevation,
                      start)
                  || !evaluate_hatch_spline (
                      edge, &sampling, end_parameter, elevation,
                      end))
                {
                  segment_iteration_reject (iteration);
                  continue;
                }
              if (!emit_hatch_ocs_segment (
                      iteration, base, normal, start, end,
                      sampling.degree > 1u, generated))
                return 0;
            }
          return 1;
        }
      count = hatch_spline_fallback_segment_count (edge);
      for (index = 0; index < count; index++)
        {
          double start[3];
          double end[3];
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          if (!hatch_spline_fallback_segment (
                  edge, index, elevation, start, end))
            {
              segment_iteration_reject (iteration);
              continue;
            }
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start, end, 1,
                  generated))
            return 0;
        }
    }
  return 1;
}

static int
iterate_hatch_boundary_segments (const Dwg_Object *object,
                                 const CacheTables *tables,
                                 SegmentIteration *iteration)
{
  const Dwg_Entity_HATCH *hatch;
  LineSegment base;
  double normal[3];
  uint64_t generated = 0;
  size_t path_count;
  size_t path_index;
  if (!object || object->fixedtype != DWG_TYPE_HATCH
      || !object->tio.entity
      || !(hatch = object->tio.entity->tio.HATCH)
      || !hatch->paths || !hatch->num_paths)
    return 1;
  if (!initialize_entity_segment (object, tables, 8, 0, &base))
    return 1;
  finite_normal_or_unit_z (
      hatch->extrusion.x, hatch->extrusion.y,
      hatch->extrusion.z, normal);
  path_count = (size_t)hatch->num_paths;
  for (path_index = 0; path_index < path_count; path_index++)
    {
      const Dwg_HATCH_Path *path = &hatch->paths[path_index];
      size_t edge_count;
      size_t edge_index;
      if (generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
        return 1;
      if ((path->flag & 2u) != 0u)
        {
          if (!iterate_hatch_polyline_path (
                  path, hatch->elevation, normal, &base, iteration,
                  &generated))
            return 0;
          continue;
        }
      if (!path->segs || !path->num_segs_or_paths)
        continue;
      edge_count = (size_t)path->num_segs_or_paths;
      for (edge_index = 0; edge_index < edge_count; edge_index++)
        {
          if (!iterate_hatch_edge (
                  &path->segs[edge_index], hatch->elevation, normal,
                  &base, iteration, &generated))
            return 0;
          if (generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
        }
    }
  return 1;
}

static int
iterate_gpu_segments (const Dwg_Data *dwg, const CacheTables *tables,
                      OverviewPlan *overview,
                      LineSegmentConsumer consumer, void *context,
                      uint64_t *selected, uint64_t *skipped,
                      uint64_t *approximated)
{
  SegmentIteration iteration;
  size_t i;
  memset (&iteration, 0, sizeof (iteration));
  iteration.overview = overview;
  iteration.consumer = consumer;
  iteration.consumer_context = context;
  if (overview)
    reset_overview_plan (overview);
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      LineSegment segment;
      int status = line_segment_from_object (object, tables, &segment);
      if (status < 0)
        iteration.skipped++;
      else if (status > 0)
        {
          if (!segment_iteration_emit (&iteration, &segment))
            return 0;
        }
      else if (!iterate_polyline_segments (
                   object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_analytic_curve_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_spline_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_hatch_boundary_segments (
              object, tables, &iteration))
        return 0;
    }
  if (selected)
    *selected = iteration.emitted;
  if (skipped)
    *skipped = iteration.skipped;
  if (approximated)
    *approximated = iteration.approximated;
  if (overview && iteration.emitted != overview->quota_total)
    return 0;
  return 1;
}

typedef struct
{
  LibreDwgGpuLineSummary *summary;
  OverviewPlan *overview;
} GpuSegmentCounter;

static int
count_gpu_segment (void *context, const LineSegment *segment)
{
  GpuSegmentCounter *counter = (GpuSegmentCounter *)context;
  size_t index = overview_group_index (segment, counter->overview);
  double midpoint[2];
  size_t axis;
  if (segment->group == UINT32_MAX)
    counter->summary->model_segments++;
  else
    counter->summary->block_segments++;
  if (segment->source_kind == 8u)
    counter->summary->hatch_boundary_segments++;
  if (index < counter->overview->group_count)
    {
      OverviewGroup *group = &counter->overview->groups[index];
      group->count++;
      midpoint[0] = segment->start[0] * 0.5 + segment->end[0] * 0.5;
      midpoint[1] = segment->start[1] * 0.5 + segment->end[1] * 0.5;
      if (!group->has_midpoint_bounds)
        {
          for (axis = 0; axis < 2; axis++)
            group->midpoint_min[axis] = group->midpoint_max[axis]
                = midpoint[axis];
          group->has_midpoint_bounds = 1;
        }
      else
        {
          for (axis = 0; axis < 2; axis++)
            {
              group->midpoint_min[axis]
                  = fmin (group->midpoint_min[axis], midpoint[axis]);
              group->midpoint_max[axis]
                  = fmax (group->midpoint_max[axis], midpoint[axis]);
            }
        }
    }
  return 1;
}

static uint64_t
bounded_hatch_segment_sum (uint64_t total, uint64_t additional)
{
  uint64_t marker = (uint64_t)MAX_HATCH_BOUNDARY_SEGMENTS + 1u;
  if (total >= marker || additional >= marker
      || additional > marker - total)
    return marker;
  return total + additional;
}

static uint64_t
hatch_edge_requested_segments (const Dwg_HATCH_PathSeg *edge)
{
  double first;
  double sweep;
  if (!edge)
    return 0;
  if (edge->curve_type == 1u)
    return 1;
  if (edge->curve_type == 2u)
    {
      if (!isfinite (edge->radius)
          || fabs (edge->radius) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 0;
      return curve_segment_count (sweep);
    }
  if (edge->curve_type == 3u)
    {
      double major_length
          = hypot (edge->endpoint.x, edge->endpoint.y);
      if (!isfinite (major_length)
          || major_length <= CURVE_EPSILON
          || !isfinite (edge->minor_major_ratio)
          || fabs (edge->minor_major_ratio) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 0;
      return curve_segment_count (sweep);
    }
  if (edge->curve_type == 4u)
    {
      SplineSampling sampling;
      memset (&sampling, 0, sizeof (sampling));
      if (read_hatch_spline_sampling (edge, &sampling))
        return sampling.segment_count;
      return hatch_spline_fallback_segment_count (edge);
    }
  return 0;
}

static uint64_t
hatch_requested_boundary_segments (const Dwg_Entity_HATCH *hatch)
{
  uint64_t total = 0;
  uint64_t marker = (uint64_t)MAX_HATCH_BOUNDARY_SEGMENTS + 1u;
  size_t path_count;
  size_t path_index;
  if (!hatch || !hatch->paths || !hatch->num_paths)
    return 0;
  path_count = (size_t)hatch->num_paths;
  for (path_index = 0; path_index < path_count; path_index++)
    {
      const Dwg_HATCH_Path *path = &hatch->paths[path_index];
      size_t item_count;
      size_t item_index;
      if ((path->flag & 2u) != 0u)
        {
          size_t source_segments;
          if (!path->polyline_paths
              || path->num_segs_or_paths < 2u)
            continue;
          item_count = (size_t)path->num_segs_or_paths;
          source_segments
              = item_count - 1u + (path->closed ? 1u : 0u);
          for (item_index = 0; item_index < source_segments;
               item_index++)
            {
              double bulge
                  = path->bulges_present
                        ? path->polyline_paths[item_index].bulge
                        : 0.0;
              total = bounded_hatch_segment_sum (
                  total, bulge_segment_count (bulge));
              if (total >= marker)
                return marker;
            }
          continue;
        }
      if (!path->segs || !path->num_segs_or_paths)
        continue;
      item_count = (size_t)path->num_segs_or_paths;
      for (item_index = 0; item_index < item_count; item_index++)
        {
          total = bounded_hatch_segment_sum (
              total,
              hatch_edge_requested_segments (&path->segs[item_index]));
          if (total >= marker)
            return marker;
        }
    }
  return total;
}

enum
{
  HATCH_RING_ERROR = -1,
  HATCH_RING_INVALID = 0,
  HATCH_RING_VALID = 1,
  HATCH_RING_OPEN = 2,
  HATCH_RING_TRUNCATED = 3
};

static uint64_t
hatch_path_requested_segments (const Dwg_HATCH_Path *path)
{
  uint64_t total = 0;
  uint64_t marker = (uint64_t)MAX_HATCH_BOUNDARY_SEGMENTS + 1u;
  size_t item_count;
  size_t item_index;
  if (!path || !path->num_segs_or_paths)
    return 0;
  item_count = (size_t)path->num_segs_or_paths;
  if ((path->flag & 2u) != 0u)
    {
      size_t source_segments;
      if (!path->polyline_paths || item_count < 2u)
        return 0;
      source_segments
          = item_count - 1u + (path->closed ? 1u : 0u);
      for (item_index = 0; item_index < source_segments;
           item_index++)
        {
          double bulge
              = path->bulges_present
                    ? path->polyline_paths[item_index].bulge
                    : 0.0;
          total = bounded_hatch_segment_sum (
              total, bulge_segment_count (bulge));
          if (total >= marker)
            return marker;
        }
      return total;
    }
  if (!path->segs)
    return 0;
  for (item_index = 0; item_index < item_count; item_index++)
    {
      uint64_t requested
          = hatch_edge_requested_segments (&path->segs[item_index]);
      if (!requested)
        return 0;
      total = bounded_hatch_segment_sum (total, requested);
      if (total >= marker)
        return marker;
    }
  return total;
}

static int
collect_hatch_segment (void *context, const LineSegment *segment)
{
  HatchSegmentCollector *collector = (HatchSegmentCollector *)context;
  if (!collector || !segment || collector->count >= collector->capacity)
    return 0;
  collector->segments[collector->count++] = *segment;
  return 1;
}

static int
hatch_points_near (const double left[3], const double right[3])
{
  double scale = 1.0;
  double tolerance;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (left[axis]) || !isfinite (right[axis]))
        return 0;
      scale = fmax (scale, fabs (left[axis]));
      scale = fmax (scale, fabs (right[axis]));
    }
  tolerance = fmax (1.0e-8, scale * DBL_EPSILON * 64.0);
  for (axis = 0; axis < 3; axis++)
    {
      if (fabs (left[axis] - right[axis]) > tolerance)
        return 0;
    }
  return 1;
}

static int
append_hatch_segment_run (HatchRing *ring,
                          const LineSegment *segments,
                          size_t count)
{
  const LineSegment *first;
  const LineSegment *last;
  int reverse = 0;
  size_t index;
  if (!ring || !ring->vertices || !segments || !count)
    return HATCH_RING_INVALID;
  first = &segments[0];
  last = &segments[count - 1u];
  if (!ring->vertex_count)
    {
      memcpy (ring->vertices[ring->vertex_count++], first->start,
              sizeof (first->start));
    }
  else if (hatch_points_near (
               ring->vertices[ring->vertex_count - 1u],
               first->start))
    reverse = 0;
  else if (hatch_points_near (
               ring->vertices[ring->vertex_count - 1u],
               last->end))
    reverse = 1;
  else
    return HATCH_RING_OPEN;

  if (reverse)
    {
      for (index = count; index > 0; index--)
        {
          const LineSegment *segment = &segments[index - 1u];
          double *current = ring->vertices[ring->vertex_count - 1u];
          if (!hatch_points_near (current, segment->end))
            return HATCH_RING_OPEN;
          if (!hatch_points_near (current, segment->start))
            {
              memcpy (ring->vertices[ring->vertex_count++],
                      segment->start, sizeof (segment->start));
            }
          if (segment->approximated_curve)
            ring->approximated_curve = 1;
        }
    }
  else
    {
      for (index = 0; index < count; index++)
        {
          const LineSegment *segment = &segments[index];
          double *current = ring->vertices[ring->vertex_count - 1u];
          if (!hatch_points_near (current, segment->start))
            return HATCH_RING_OPEN;
          if (!hatch_points_near (current, segment->end))
            {
              memcpy (ring->vertices[ring->vertex_count++],
                      segment->end, sizeof (segment->end));
            }
          if (segment->approximated_curve)
            ring->approximated_curve = 1;
        }
    }
  return HATCH_RING_VALID;
}

static int
hatch_projected_area (const HatchRing *ring, const double normal[3],
                      double *signed_area, double *extent)
{
  size_t dropped_axis;
  size_t first_axis;
  size_t second_axis;
  double origin[2];
  double twice_area = 0.0;
  double maximum_extent = 0.0;
  size_t index;
  if (!ring || !ring->vertices || ring->vertex_count < 3u
      || !normal || !signed_area || !extent)
    return 0;
  if (fabs (normal[0]) >= fabs (normal[1])
      && fabs (normal[0]) >= fabs (normal[2]))
    dropped_axis = 0;
  else if (fabs (normal[1]) >= fabs (normal[2]))
    dropped_axis = 1;
  else
    dropped_axis = 2;
  if (dropped_axis == 0)
    {
      first_axis = 1;
      second_axis = 2;
    }
  else if (dropped_axis == 1)
    {
      first_axis = 0;
      second_axis = 2;
    }
  else
    {
      first_axis = 0;
      second_axis = 1;
    }
  origin[0] = ring->vertices[0][first_axis];
  origin[1] = ring->vertices[0][second_axis];
  for (index = 0; index < ring->vertex_count; index++)
    {
      const double *left = ring->vertices[index];
      const double *right
          = ring->vertices[(index + 1u) % ring->vertex_count];
      double left_x = left[first_axis] - origin[0];
      double left_y = left[second_axis] - origin[1];
      double right_x = right[first_axis] - origin[0];
      double right_y = right[second_axis] - origin[1];
      if (!isfinite (left_x) || !isfinite (left_y)
          || !isfinite (right_x) || !isfinite (right_y))
        return 0;
      maximum_extent = fmax (maximum_extent, fabs (left_x));
      maximum_extent = fmax (maximum_extent, fabs (left_y));
      maximum_extent = fmax (maximum_extent, fabs (right_x));
      maximum_extent = fmax (maximum_extent, fabs (right_y));
      twice_area += left_x * right_y - right_x * left_y;
    }
  *signed_area = twice_area * 0.5;
  *extent = maximum_extent;
  return isfinite (*signed_area) && isfinite (*extent);
}

static void
free_hatch_ring (HatchRing *ring)
{
  if (!ring)
    return;
  free (ring->vertices);
  memset (ring, 0, sizeof (*ring));
}

static int
build_hatch_ring (CacheWriter *writer, const Dwg_Entity_HATCH *hatch,
                  const Dwg_HATCH_Path *path, uint64_t maximum_vertices,
                  HatchRing *ring)
{
  uint64_t requested;
  LineSegment *segments = NULL;
  HatchSegmentCollector collector;
  SegmentIteration iteration;
  LineSegment base;
  double normal[3];
  double extent;
  uint64_t generated;
  size_t item_count;
  size_t item_index;
  int status = HATCH_RING_INVALID;
  if (!writer || !hatch || !path || !ring)
    return HATCH_RING_INVALID;
  memset (ring, 0, sizeof (*ring));
  requested = hatch_path_requested_segments (path);
  if (requested < 3u)
    return HATCH_RING_INVALID;
  if (requested > maximum_vertices
      || requested > MAX_HATCH_BOUNDARY_SEGMENTS)
    return HATCH_RING_TRUNCATED;
  if (requested > SIZE_MAX - 1u)
    {
      set_error (writer, "HATCH ring exceeds platform limits");
      return HATCH_RING_ERROR;
    }
  segments = (LineSegment *)calloc ((size_t)requested,
                                    sizeof (LineSegment));
  ring->vertices = (double (*)[3])calloc (
      (size_t)requested + 1u, sizeof (*ring->vertices));
  if (!segments || !ring->vertices)
    {
      set_error (writer, "cannot allocate bounded HATCH ring");
      status = HATCH_RING_ERROR;
      goto done;
    }
  finite_normal_or_unit_z (
      hatch->extrusion.x, hatch->extrusion.y,
      hatch->extrusion.z, normal);
  memset (&collector, 0, sizeof (collector));
  collector.segments = segments;
  collector.capacity = (size_t)requested;
  memset (&iteration, 0, sizeof (iteration));
  iteration.consumer = collect_hatch_segment;
  iteration.consumer_context = &collector;
  memset (&base, 0, sizeof (base));

  item_count = (size_t)path->num_segs_or_paths;
  if ((path->flag & 2u) != 0u)
    {
      generated = 0;
      if (!iterate_hatch_polyline_path (
              path, hatch->elevation, normal, &base, &iteration,
              &generated))
        {
          set_error (writer, "cannot collect bounded HATCH polyline");
          status = HATCH_RING_ERROR;
          goto done;
        }
      if (iteration.skipped || collector.count != (size_t)requested)
        goto done;
      status = append_hatch_segment_run (
          ring, segments, collector.count);
      ring->source_edge_count = 1u;
      if (status != HATCH_RING_VALID)
        goto done;
    }
  else
    {
      ring->source_edge_count = (uint32_t)item_count;
      for (item_index = 0; item_index < item_count; item_index++)
        {
          size_t first_segment = collector.count;
          generated = 0;
          if (!iterate_hatch_edge (
                  &path->segs[item_index], hatch->elevation,
                  normal, &base, &iteration, &generated))
            {
              set_error (writer, "cannot collect bounded HATCH edge");
              status = HATCH_RING_ERROR;
              goto done;
            }
          if (collector.count == first_segment)
            goto done;
          status = append_hatch_segment_run (
              ring, &segments[first_segment],
              collector.count - first_segment);
          if (status != HATCH_RING_VALID)
            goto done;
        }
      if (iteration.skipped || collector.count != (size_t)requested)
        {
          status = HATCH_RING_INVALID;
          goto done;
        }
    }

  if (ring->vertex_count < 4u
      || !hatch_points_near (
          ring->vertices[0],
          ring->vertices[ring->vertex_count - 1u]))
    {
      status = HATCH_RING_OPEN;
      goto done;
    }
  ring->vertex_count--;
  if (ring->vertex_count < 3u
      || !hatch_projected_area (
          ring, normal, &ring->signed_area, &extent)
      || fabs (ring->signed_area)
             <= fmax (extent * extent * 1.0e-14, 1.0e-18))
    {
      status = HATCH_RING_INVALID;
      goto done;
    }
  status = HATCH_RING_VALID;

done:
  free (segments);
  if (status != HATCH_RING_VALID)
    free_hatch_ring (ring);
  return status;
}

static int
scan_hatch_paths (CacheWriter *writer, const Dwg_Object *object,
                  const Dwg_Entity_HATCH *hatch, uint64_t hatch_index,
                  uint64_t *global_vertices,
                  HatchRingConsumer consumer, void *consumer_context,
                  HatchEntityScan *scan)
{
  uint64_t hatch_vertices = 0;
  size_t path_count;
  size_t path_index;
  if (!writer || !hatch || !global_vertices || !scan)
    return 0;
  memset (scan, 0, sizeof (*scan));
  if (!hatch->paths || !hatch->num_paths)
    return 1;
  path_count = (size_t)hatch->num_paths;
  for (path_index = 0; path_index < path_count; path_index++)
    {
      const Dwg_HATCH_Path *path = &hatch->paths[path_index];
      HatchRing ring;
      uint64_t hatch_remaining
          = MAX_HATCH_BOUNDARY_SEGMENTS - hatch_vertices;
      uint64_t global_remaining
          = MAX_HATCH_FILL_VERTICES - *global_vertices;
      uint64_t maximum_vertices
          = hatch_remaining < global_remaining
                ? hatch_remaining
                : global_remaining;
      int status;
      if ((path->flag & 32u) != 0u
          || ((path->flag & 2u) != 0u && !path->closed))
        {
          scan->skipped_open_paths++;
          continue;
        }
      status = build_hatch_ring (
          writer, hatch, path, maximum_vertices, &ring);
      if (status == HATCH_RING_ERROR)
        return 0;
      if (status == HATCH_RING_TRUNCATED)
        {
          scan->truncated = 1;
          break;
        }
      if (status == HATCH_RING_OPEN)
        {
          scan->skipped_open_paths++;
          continue;
        }
      if (status == HATCH_RING_INVALID)
        {
          scan->skipped_invalid_paths++;
          continue;
        }
      if (path_index > UINT32_MAX
          || (consumer
              && !consumer (
                  consumer_context, object, hatch, hatch_index,
                  (uint32_t)path_index, path, &ring)))
        {
          free_hatch_ring (&ring);
          if (!writer->failed)
            set_error (writer, "cannot write bounded HATCH ring");
          return 0;
        }
      hatch_vertices += (uint64_t)ring.vertex_count;
      *global_vertices += (uint64_t)ring.vertex_count;
      scan->loops++;
      scan->vertices += (uint64_t)ring.vertex_count;
      free_hatch_ring (&ring);
    }
  return 1;
}

static uint64_t
scan_hatch_gradient_colors (const Dwg_Entity_HATCH *hatch,
                            uint64_t *global_count, int *truncated)
{
  uint64_t count = 0;
  size_t index;
  if (!hatch || !global_count || !truncated)
    return 0;
  if (hatch->num_colors > 0 && !hatch->colors)
    {
      *truncated = 1;
      return 0;
    }
  for (index = 0; hatch->colors
                  && index < (size_t)hatch->num_colors;
       index++)
    {
      if (*global_count >= MAX_HATCH_AUX_RECORDS
          || !isfinite (hatch->colors[index].shift_value))
        {
          *truncated = 1;
          continue;
        }
      (*global_count)++;
      count++;
    }
  return count;
}

static uint64_t
scan_hatch_seed_points (const Dwg_Entity_HATCH *hatch,
                        uint64_t *global_count, int *truncated)
{
  uint64_t count = 0;
  size_t index;
  if (!hatch || !global_count || !truncated)
    return 0;
  if (hatch->num_seeds > 0 && !hatch->seeds)
    {
      *truncated = 1;
      return 0;
    }
  for (index = 0; hatch->seeds
                  && index < (size_t)hatch->num_seeds;
       index++)
    {
      if (*global_count >= MAX_HATCH_AUX_RECORDS
          || !isfinite (hatch->seeds[index].x)
          || !isfinite (hatch->seeds[index].y))
        {
          *truncated = 1;
          continue;
        }
      (*global_count)++;
      count++;
    }
  return count;
}

static int
hatch_pattern_line_is_finite (const Dwg_HATCH_DefLine *line)
{
  size_t dash_index;
  if (!line || !isfinite (line->angle) || !isfinite (line->pt0.x)
      || !isfinite (line->pt0.y) || !isfinite (line->offset.x)
      || !isfinite (line->offset.y)
      || (line->num_dashes > 0u && !line->dashes))
    return 0;
  for (dash_index = 0; dash_index < (size_t)line->num_dashes;
       dash_index++)
    {
      if (!isfinite (line->dashes[dash_index]))
        return 0;
    }
  return 1;
}

static int
scan_hatch_pattern_lines (
    const Dwg_Entity_HATCH *hatch, uint64_t hatch_index,
    uint64_t *global_lines, uint64_t *global_dashes,
    HatchPatternLineConsumer consumer, void *consumer_context,
    HatchPatternScan *scan)
{
  size_t source_line_index;
  if (!hatch || !global_lines || !global_dashes || !scan)
    return 0;
  memset (scan, 0, sizeof (*scan));
  if (hatch->num_deflines > 0u && !hatch->deflines)
    {
      scan->truncated = 1;
      return 1;
    }
  for (source_line_index = 0;
       hatch->deflines
       && source_line_index < (size_t)hatch->num_deflines;
       source_line_index++)
    {
      const Dwg_HATCH_DefLine *line
          = &hatch->deflines[source_line_index];
      uint64_t dash_count = (uint64_t)line->num_dashes;
      uint64_t first_dash;
      if (!hatch_pattern_line_is_finite (line))
        {
          scan->invalid_lines++;
          continue;
        }
      if (scan->lines >= MAX_HATCH_PATTERN_LINES_PER_ENTITY
          || scan->dashes
                     > MAX_HATCH_PATTERN_DASHES_PER_ENTITY - dash_count
          || *global_lines >= MAX_HATCH_PATTERN_LINES
          || *global_dashes > MAX_HATCH_PATTERN_DASHES - dash_count)
        {
          scan->truncated = 1;
          break;
        }
      first_dash = *global_dashes;
      if (consumer
          && !consumer (
              consumer_context, hatch_index,
              (uint32_t)source_line_index, line, first_dash,
              (uint32_t)dash_count))
        return 0;
      (*global_lines)++;
      *global_dashes += dash_count;
      scan->lines++;
      scan->dashes += dash_count;
    }
  return 1;
}

static double
finite_or_default (double value, double fallback)
{
  return isfinite (value) ? value : fallback;
}

static int
copy_hatch_names (const Dwg_Entity_HATCH *hatch, char **pattern_name,
                  char **gradient_name)
{
  *pattern_name = copy_utf8_field (
      (void *)hatch, "HATCH", "name", "");
  *gradient_name = copy_utf8_field (
      (void *)hatch, "HATCH", "gradient_name", "");
  if (!*pattern_name || !*gradient_name)
    {
      free (*pattern_name);
      free (*gradient_name);
      *pattern_name = NULL;
      *gradient_name = NULL;
      return 0;
    }
  return 1;
}

static int
write_hatch_entity_section (
    CacheWriter *writer, const Dwg_Data *dwg,
    const CacheTables *tables, const LibreDwgPrimitiveCounts *counts,
    LibreDwgHatchFillSummary *summary, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_offset;
  uint64_t string_cursor = 0;
  uint64_t global_vertices = 0;
  uint64_t global_gradient_colors = 0;
  uint64_t global_seed_points = 0;
  uint64_t global_pattern_lines = 0;
  uint64_t global_pattern_dashes = 0;
  uint64_t first_loop = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  if (counts->hatches > UINT32_MAX
      || counts->hatches
             > (UINT64_MAX - STRING_TABLE_HEADER_SIZE)
                   / HATCH_ENTITY_RECORD_SIZE)
    {
      set_error (writer, "too many HATCH entities for scene cache");
      return 0;
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE
        + counts->hatches * HATCH_ENTITY_RECORD_SIZE;
  memset (summary, 0, sizeof (*summary));
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)counts->hatches)
      || !write_u32 (writer, HATCH_ENTITY_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    return 0;

  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchEntityScan scan;
      HatchPatternScan pattern_scan;
      char *pattern_name = NULL;
      char *gradient_name = NULL;
      uint32_t pattern_offset;
      uint32_t pattern_length;
      uint32_t gradient_offset;
      uint32_t gradient_length;
      uint32_t flags = 0;
      uint64_t first_gradient_color = global_gradient_colors;
      uint64_t first_seed_point = global_seed_points;
      uint64_t gradient_color_count;
      uint64_t seed_point_count;
      double normal[3];
      int fill_truncated = 0;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_paths (
              writer, object, hatch, hatch_index, &global_vertices,
              NULL, NULL, &scan))
        return 0;
      gradient_color_count = scan_hatch_gradient_colors (
          hatch, &global_gradient_colors, &fill_truncated);
      seed_point_count = scan_hatch_seed_points (
          hatch, &global_seed_points, &fill_truncated);
      fill_truncated |= scan.truncated;
      if (!scan_hatch_pattern_lines (
              hatch, hatch_index, &global_pattern_lines,
              &global_pattern_dashes, NULL, NULL, &pattern_scan))
        return 0;
      if (!copy_hatch_names (
              hatch, &pattern_name, &gradient_name)
          || !checked_string_layout (
              &string_cursor, pattern_name, &pattern_offset,
              &pattern_length)
          || !checked_string_layout (
              &string_cursor, gradient_name, &gradient_offset,
              &gradient_length))
        {
          free (pattern_name);
          free (gradient_name);
          set_error (writer, "cannot prepare bounded HATCH strings");
          return 0;
        }
      finite_normal_or_unit_z (
          hatch->extrusion.x, hatch->extrusion.y,
          hatch->extrusion.z, normal);
      if (hatch->is_solid_fill)
        flags |= HATCH_FLAG_SOLID;
      if (hatch->is_associative)
        flags |= HATCH_FLAG_ASSOCIATIVE;
      if (hatch->double_flag)
        flags |= HATCH_FLAG_DOUBLE;
      if (hatch->is_gradient_fill)
        flags |= HATCH_FLAG_GRADIENT;
      if (hatch->single_color_gradient)
        flags |= HATCH_FLAG_SINGLE_COLOR_GRADIENT;
      if (fill_truncated || pattern_scan.truncated)
        flags |= HATCH_FLAG_TRUNCATED;

      if (!write_common (writer, object, tables)
          || !write_u32 (writer, pattern_offset)
          || !write_u32 (writer, pattern_length)
          || !write_u32 (writer, gradient_offset)
          || !write_u32 (writer, gradient_length)
          || !write_u32 (writer, flags)
          || !write_u16 (writer, (uint16_t)hatch->style)
          || !write_u16 (writer, (uint16_t)hatch->pattern_type)
          || !write_u64 (writer, first_loop)
          || !write_u64 (writer, scan.loops)
          || !write_u64 (writer, first_gradient_color)
          || !write_u64 (writer, gradient_color_count)
          || !write_f64 (
              writer, finite_or_default (hatch->elevation, 0.0))
          || !write_vec3 (writer, normal)
          || !write_f64 (
              writer, finite_or_default (hatch->angle, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->scale_spacing, 1.0))
          || !write_f64 (
              writer, finite_or_default (hatch->pixel_size, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->gradient_angle, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->gradient_shift, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->gradient_tint, 0.0))
          || !write_u64 (writer, first_seed_point)
          || !write_u64 (writer, seed_point_count)
          || !write_i32 (writer, (int32_t)hatch->reserved)
          || !write_u32 (writer, (uint32_t)hatch->num_deflines))
        {
          free (pattern_name);
          free (gradient_name);
          return 0;
        }
      free (pattern_name);
      free (gradient_name);

      summary->source_hatches++;
      if (hatch->is_gradient_fill)
        summary->gradient_hatches++;
      else if (hatch->is_solid_fill)
        summary->solid_hatches++;
      else
        summary->pattern_hatches++;
      summary->fill_loops += scan.loops;
      summary->fill_vertices += scan.vertices;
      summary->gradient_colors += gradient_color_count;
      summary->seed_points += seed_point_count;
      summary->pattern_definition_lines += pattern_scan.lines;
      summary->pattern_dashes += pattern_scan.dashes;
      summary->skipped_open_paths += scan.skipped_open_paths;
      summary->skipped_invalid_paths += scan.skipped_invalid_paths;
      summary->skipped_invalid_pattern_lines
          += pattern_scan.invalid_lines;
      if (fill_truncated)
        summary->truncated_fill_hatches++;
      if (pattern_scan.truncated)
        summary->truncated_pattern_hatches++;
      first_loop += scan.loops;
      hatch_index++;
    }
  if (hatch_index != counts->hatches
      || first_loop != summary->fill_loops
      || global_vertices != summary->fill_vertices
      || global_pattern_lines != summary->pattern_definition_lines
      || global_pattern_dashes != summary->pattern_dashes)
    {
      set_error (writer, "HATCH entity counts changed while writing");
      return 0;
    }

  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      char *pattern_name = NULL;
      char *gradient_name = NULL;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!copy_hatch_names (
              hatch, &pattern_name, &gradient_name))
        {
          set_error (writer, "cannot copy bounded HATCH strings");
          return 0;
        }
      if (!write_bytes (
              writer, pattern_name, strlen (pattern_name))
          || !write_bytes (
              writer, gradient_name, strlen (gradient_name)))
        {
          free (pattern_name);
          free (gradient_name);
          return 0;
        }
      free (pattern_name);
      free (gradient_name);
    }
  return finish_variable_section (
      writer, entry, SECTION_HATCH_ENTITIES,
      HATCH_ENTITY_RECORD_SIZE, "hatch_entities", offset,
      counts->hatches, SECTION_FLAG_STRING_TABLE);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t first_vertex;
  uint64_t loops;
} HatchLoopWriter;

static int
write_hatch_loop (void *context, const Dwg_Object *object,
                  const Dwg_Entity_HATCH *hatch,
                  uint64_t hatch_index, uint32_t path_index,
                  const Dwg_HATCH_Path *path, const HatchRing *ring)
{
  HatchLoopWriter *writer = (HatchLoopWriter *)context;
  uint32_t flags
      = ring->approximated_curve
            ? HATCH_LOOP_FLAG_APPROXIMATED_CURVE
            : 0u;
  (void)object;
  (void)hatch;
  if (!write_u64 (writer->writer, hatch_index)
      || !write_u32 (writer->writer, (uint32_t)path->flag)
      || !write_u32 (writer->writer, path_index)
      || !write_u64 (writer->writer, writer->first_vertex)
      || !write_u64 (
          writer->writer, (uint64_t)ring->vertex_count)
      || !write_u32 (writer->writer, ring->source_edge_count)
      || !write_u32 (writer->writer, flags)
      || !write_f64 (writer->writer, ring->signed_area))
    return 0;
  writer->first_vertex += (uint64_t)ring->vertex_count;
  writer->loops++;
  return 1;
}

static int
write_hatch_loop_section (CacheWriter *writer, const Dwg_Data *dwg,
                          SectionEntry *entry)
{
  HatchLoopWriter loop_writer;
  uint64_t offset;
  uint64_t global_vertices = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&loop_writer, 0, sizeof (loop_writer));
  loop_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchEntityScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_paths (
              writer, object, hatch, hatch_index, &global_vertices,
              write_hatch_loop, &loop_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (loop_writer.first_vertex != global_vertices)
    {
      set_error (writer, "HATCH loop and vertex counts differ");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_LOOPS, HATCH_LOOP_RECORD_SIZE,
      "hatch_loops", offset, loop_writer.loops);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t vertices;
} HatchVertexWriter;

static int
write_hatch_vertices (void *context, const Dwg_Object *object,
                      const Dwg_Entity_HATCH *hatch,
                      uint64_t hatch_index, uint32_t path_index,
                      const Dwg_HATCH_Path *path,
                      const HatchRing *ring)
{
  HatchVertexWriter *writer = (HatchVertexWriter *)context;
  size_t index;
  (void)object;
  (void)hatch;
  (void)hatch_index;
  (void)path_index;
  (void)path;
  for (index = 0; index < ring->vertex_count; index++)
    {
      if (!write_vec3 (writer->writer, ring->vertices[index]))
        return 0;
      writer->vertices++;
    }
  return 1;
}

static int
write_hatch_vertex_section (CacheWriter *writer, const Dwg_Data *dwg,
                            SectionEntry *entry)
{
  HatchVertexWriter vertex_writer;
  uint64_t offset;
  uint64_t global_vertices = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&vertex_writer, 0, sizeof (vertex_writer));
  vertex_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchEntityScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_paths (
              writer, object, hatch, hatch_index, &global_vertices,
              write_hatch_vertices, &vertex_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (vertex_writer.vertices != global_vertices)
    {
      set_error (writer, "HATCH vertex pass changed record count");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_VERTICES,
      HATCH_VERTEX_RECORD_SIZE, "hatch_vertices", offset,
      vertex_writer.vertices);
}

static int
write_hatch_gradient_color_section (CacheWriter *writer,
                                    const Dwg_Data *dwg,
                                    SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      size_t color_index;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH)
          || !hatch->colors)
        continue;
      for (color_index = 0;
           color_index < (size_t)hatch->num_colors;
           color_index++)
        {
          const Dwg_HATCH_Color *color = &hatch->colors[color_index];
          if (count >= MAX_HATCH_AUX_RECORDS
              || !isfinite (color->shift_value))
            continue;
          if (!write_f64 (writer, color->shift_value)
              || !write_u32 (writer, encode_color (&color->color))
              || !write_u32 (writer, 0))
            return 0;
          count++;
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_GRADIENT_COLORS,
      HATCH_GRADIENT_COLOR_RECORD_SIZE, "hatch_gradient_colors",
      offset, count);
}

static int
write_hatch_seed_point_section (CacheWriter *writer,
                                const Dwg_Data *dwg,
                                SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      size_t seed_index;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH)
          || !hatch->seeds)
        continue;
      for (seed_index = 0; seed_index < (size_t)hatch->num_seeds;
           seed_index++)
        {
          const BITCODE_2RD *seed = &hatch->seeds[seed_index];
          if (count >= MAX_HATCH_AUX_RECORDS
              || !isfinite (seed->x) || !isfinite (seed->y))
            continue;
          if (!write_f64 (writer, seed->x)
              || !write_f64 (writer, seed->y))
            return 0;
          count++;
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_SEED_POINTS,
      HATCH_SEED_POINT_RECORD_SIZE, "hatch_seed_points", offset,
      count);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t lines;
} HatchPatternLineWriter;

static int
write_hatch_pattern_line (
    void *context, uint64_t hatch_index, uint32_t source_line_index,
    const Dwg_HATCH_DefLine *line, uint64_t first_dash,
    uint32_t dash_count)
{
  HatchPatternLineWriter *writer
      = (HatchPatternLineWriter *)context;
  if (!write_u64 (writer->writer, hatch_index)
      || !write_u32 (writer->writer, source_line_index)
      || !write_u32 (writer->writer, 0)
      || !write_f64 (writer->writer, line->angle)
      || !write_f64 (writer->writer, line->pt0.x)
      || !write_f64 (writer->writer, line->pt0.y)
      || !write_f64 (writer->writer, line->offset.x)
      || !write_f64 (writer->writer, line->offset.y)
      || !write_u64 (writer->writer, first_dash)
      || !write_u32 (writer->writer, dash_count)
      || !write_u32 (writer->writer, 0))
    return 0;
  writer->lines++;
  return 1;
}

static int
write_hatch_pattern_line_section (CacheWriter *writer,
                                  const Dwg_Data *dwg,
                                  SectionEntry *entry)
{
  HatchPatternLineWriter line_writer;
  uint64_t offset;
  uint64_t global_lines = 0;
  uint64_t global_dashes = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&line_writer, 0, sizeof (line_writer));
  line_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchPatternScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_pattern_lines (
              hatch, hatch_index, &global_lines, &global_dashes,
              write_hatch_pattern_line, &line_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (line_writer.lines != global_lines)
    {
      set_error (writer, "HATCH pattern-line pass changed record count");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_PATTERN_LINES,
      HATCH_PATTERN_LINE_RECORD_SIZE, "hatch_pattern_lines", offset,
      line_writer.lines);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t dashes;
} HatchPatternDashWriter;

static int
write_hatch_pattern_dashes (
    void *context, uint64_t hatch_index, uint32_t source_line_index,
    const Dwg_HATCH_DefLine *line, uint64_t first_dash,
    uint32_t dash_count)
{
  HatchPatternDashWriter *writer
      = (HatchPatternDashWriter *)context;
  size_t dash_index;
  (void)hatch_index;
  (void)source_line_index;
  if (first_dash != writer->dashes)
    return 0;
  for (dash_index = 0; dash_index < (size_t)dash_count; dash_index++)
    {
      if (!write_f64 (writer->writer, line->dashes[dash_index]))
        return 0;
      writer->dashes++;
    }
  return 1;
}

static int
write_hatch_pattern_dash_section (CacheWriter *writer,
                                  const Dwg_Data *dwg,
                                  SectionEntry *entry)
{
  HatchPatternDashWriter dash_writer;
  uint64_t offset;
  uint64_t global_lines = 0;
  uint64_t global_dashes = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&dash_writer, 0, sizeof (dash_writer));
  dash_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchPatternScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_pattern_lines (
              hatch, hatch_index, &global_lines, &global_dashes,
              write_hatch_pattern_dashes, &dash_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (dash_writer.dashes != global_dashes)
    {
      set_error (writer, "HATCH pattern-dash pass changed record count");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_PATTERN_DASHES,
      HATCH_PATTERN_DASH_RECORD_SIZE, "hatch_pattern_dashes", offset,
      dash_writer.dashes);
}

static int
write_point_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                            const CacheTables *tables,
                            SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_POINT *point;
      double location[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_POINT || !object->tio.entity
          || !(point = object->tio.entity->tio.POINT))
        continue;
      location[0] = point->x;
      location[1] = point->y;
      location[2] = point->z;
      if (!isfinite (location[0]) || !isfinite (location[1])
          || !isfinite (location[2]) || !isfinite (point->thickness)
          || !isfinite (point->x_ang)
          || !isfinite (dwg->header_vars.PDSIZE))
        {
          set_error (writer, "POINT source contains a non-finite value");
          return 0;
        }
      finite_normal_or_unit_z (
          point->extrusion.x, point->extrusion.y, point->extrusion.z,
          normal);
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, location)
          || !write_vec3 (writer, normal)
          || !write_f64 (writer, point->thickness)
          || !write_f64 (writer, point->x_ang)
          || !write_f64 (writer, dwg->header_vars.PDSIZE)
          || !write_i16 (writer, (int16_t)dwg->header_vars.PDMODE)
          || !write_u16 (writer, 0) || !write_u32 (writer, 0))
        return 0;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_POINT_ENTITIES, POINT_ENTITY_RECORD_SIZE,
      "point_entities", offset, count);
}

static int
write_solid_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                            const CacheTables *tables,
                            SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_SOLID *solid;
      double corners[4][3];
      double normal[3];
      size_t corner_index;
      if (object->fixedtype != DWG_TYPE_SOLID || !object->tio.entity
          || !(solid = object->tio.entity->tio.SOLID))
        continue;
      corners[0][0] = solid->corner1.x;
      corners[0][1] = solid->corner1.y;
      corners[1][0] = solid->corner2.x;
      corners[1][1] = solid->corner2.y;
      corners[2][0] = solid->corner3.x;
      corners[2][1] = solid->corner3.y;
      corners[3][0] = solid->corner4.x;
      corners[3][1] = solid->corner4.y;
      for (corner_index = 0; corner_index < 4; corner_index++)
        corners[corner_index][2] = solid->elevation;
      if (!isfinite (solid->elevation)
          || !isfinite (solid->thickness))
        {
          set_error (writer, "SOLID source contains a non-finite value");
          return 0;
        }
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          if (!isfinite (corners[corner_index][0])
              || !isfinite (corners[corner_index][1]))
            {
              set_error (
                  writer, "SOLID source contains a non-finite corner");
              return 0;
            }
        }
      finite_normal_or_unit_z (
          solid->extrusion.x, solid->extrusion.y, solid->extrusion.z,
          normal);
      if (!write_common (writer, object, tables)
          || !write_u32 (writer, dwg->header_vars.FILLMODE ? 1u : 0u)
          || !write_u32 (writer, 0))
        return 0;
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          if (!write_vec3 (writer, corners[corner_index]))
            return 0;
        }
      if (!write_vec3 (writer, normal)
          || !write_f64 (writer, solid->thickness))
        return 0;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SOLID_ENTITIES, SOLID_ENTITY_RECORD_SIZE,
      "solid_entities", offset, count);
}

static int
write_face_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                           const CacheTables *tables,
                           SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity__3DFACE *face;
      const BITCODE_3BD *corners[4];
      size_t corner_index;
      if (object->fixedtype != DWG_TYPE__3DFACE || !object->tio.entity
          || !(face = object->tio.entity->tio._3DFACE))
        continue;
      if (((uint32_t)face->invis_flags & ~15u) != 0)
        {
          set_error (
              writer,
              "3DFACE source contains unsupported invisible-edge flags");
          return 0;
        }
      corners[0] = &face->corner1;
      corners[1] = &face->corner2;
      corners[2] = &face->corner3;
      corners[3] = &face->corner4;
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          if (!isfinite (corners[corner_index]->x)
              || !isfinite (corners[corner_index]->y)
              || !isfinite (corners[corner_index]->z))
            {
              set_error (
                  writer, "3DFACE source contains a non-finite corner");
              return 0;
            }
        }
      if (!write_common (writer, object, tables)
          || !write_u32 (writer, (uint32_t)face->invis_flags)
          || !write_u32 (writer, 0))
        return 0;
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          const double corner[3]
              = { corners[corner_index]->x, corners[corner_index]->y,
                  corners[corner_index]->z };
          if (!write_vec3 (writer, corner))
            return 0;
        }
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_FACE_ENTITIES, FACE_ENTITY_RECORD_SIZE,
      "face_entities", offset, count);
}

static int
validate_wipeout_source (CacheWriter *writer,
                         const Dwg_Entity_WIPEOUT *wipeout)
{
  double cross_x;
  double cross_y;
  double cross_z;
  double basis_length_squared;
  uint32_t vertex_index;
  if ((uint32_t)wipeout->class_version > INT32_MAX)
    {
      set_error (writer, "WIPEOUT class version exceeds cache limits");
      return 0;
    }
  if (((uint32_t)wipeout->display_props & ~15u) != 0)
    {
      set_error (
          writer,
          "WIPEOUT source contains unsupported display properties");
      return 0;
    }
  if ((uint32_t)wipeout->clipping > 1u
      || (uint32_t)wipeout->clip_mode > 1u
      || (uint32_t)wipeout->brightness > 100u
      || (uint32_t)wipeout->contrast > 100u
      || (uint32_t)wipeout->fade > 100u)
    {
      set_error (writer, "WIPEOUT source contains invalid image metadata");
      return 0;
    }
  if (((uint32_t)wipeout->clip_boundary_type == 1u
       && (uint32_t)wipeout->num_clip_verts != 2u)
      || ((uint32_t)wipeout->clip_boundary_type == 2u
          && (uint32_t)wipeout->num_clip_verts < 3u)
      || ((uint32_t)wipeout->clip_boundary_type != 1u
          && (uint32_t)wipeout->clip_boundary_type != 2u))
    {
      set_error (writer, "WIPEOUT source contains an invalid clip boundary");
      return 0;
    }
  if ((uint32_t)wipeout->num_clip_verts > MAX_WIPEOUT_CLIP_VERTICES
      || (wipeout->num_clip_verts && !wipeout->clip_verts))
    {
      set_error (writer, "WIPEOUT clip boundary exceeds cache limits");
      return 0;
    }
  if (!isfinite (wipeout->pt0.x) || !isfinite (wipeout->pt0.y)
      || !isfinite (wipeout->pt0.z) || !isfinite (wipeout->uvec.x)
      || !isfinite (wipeout->uvec.y) || !isfinite (wipeout->uvec.z)
      || !isfinite (wipeout->vvec.x) || !isfinite (wipeout->vvec.y)
      || !isfinite (wipeout->vvec.z)
      || !isfinite (wipeout->image_size.x)
      || !isfinite (wipeout->image_size.y)
      || wipeout->image_size.x <= 0.0 || wipeout->image_size.y <= 0.0)
    {
      set_error (
          writer,
          "WIPEOUT source contains a non-finite or invalid coordinate");
      return 0;
    }
  for (vertex_index = 0;
       vertex_index < (uint32_t)wipeout->num_clip_verts; vertex_index++)
    {
      if (!isfinite (wipeout->clip_verts[vertex_index].x)
          || !isfinite (wipeout->clip_verts[vertex_index].y))
        {
          set_error (
              writer,
              "WIPEOUT source contains a non-finite clip coordinate");
          return 0;
        }
    }
  cross_x = wipeout->uvec.y * wipeout->vvec.z
            - wipeout->uvec.z * wipeout->vvec.y;
  cross_y = wipeout->uvec.z * wipeout->vvec.x
            - wipeout->uvec.x * wipeout->vvec.z;
  cross_z = wipeout->uvec.x * wipeout->vvec.y
            - wipeout->uvec.y * wipeout->vvec.x;
  basis_length_squared
      = cross_x * cross_x + cross_y * cross_y + cross_z * cross_z;
  if (!isfinite (basis_length_squared)
      || basis_length_squared <= 1.0e-24)
    {
      set_error (writer, "WIPEOUT source contains a degenerate image basis");
      return 0;
    }
  return 1;
}

static int
write_wipeout_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                              const CacheTables *tables,
                              SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  uint64_t first_clip_vertex = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_WIPEOUT *wipeout;
      uint32_t clip_vertex_count;
      double insertion_point[3];
      double u_vector[3];
      double v_vector[3];
      if (object->fixedtype != DWG_TYPE_WIPEOUT || !object->tio.entity
          || !(wipeout = object->tio.entity->tio.WIPEOUT))
        continue;
      if (!validate_wipeout_source (writer, wipeout))
        return 0;
      count++;
      if (count > MAX_WIPEOUT_SOURCE_RECORDS)
        {
          set_error (writer, "WIPEOUT source exceeds its entity limit");
          return 0;
        }
      clip_vertex_count = (uint32_t)wipeout->num_clip_verts;
      if (first_clip_vertex
          > (uint64_t)MAX_WIPEOUT_CLIP_VERTICES - clip_vertex_count)
        {
          set_error (
              writer,
              "WIPEOUT source exceeds its clip-vertex limit");
          return 0;
        }
      insertion_point[0] = wipeout->pt0.x;
      insertion_point[1] = wipeout->pt0.y;
      insertion_point[2] = wipeout->pt0.z;
      u_vector[0] = wipeout->uvec.x;
      u_vector[1] = wipeout->uvec.y;
      u_vector[2] = wipeout->uvec.z;
      v_vector[0] = wipeout->vvec.x;
      v_vector[1] = wipeout->vvec.y;
      v_vector[2] = wipeout->vvec.z;
      if (!write_common (writer, object, tables)
          || !write_i32 (writer, (int32_t)wipeout->class_version)
          || !write_u16 (writer, (uint16_t)wipeout->display_props)
          || !write_u8 (
              writer, (uint8_t)wipeout->clip_boundary_type)
          || !write_u8 (writer, (uint8_t)wipeout->clipping)
          || !write_u8 (writer, (uint8_t)wipeout->brightness)
          || !write_u8 (writer, (uint8_t)wipeout->contrast)
          || !write_u8 (writer, (uint8_t)wipeout->fade)
          || !write_u8 (writer, (uint8_t)wipeout->clip_mode)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, first_clip_vertex)
          || !write_u32 (writer, clip_vertex_count)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, reference_handle (wipeout->imagedef))
          || !write_u64 (
              writer, reference_handle (wipeout->imagedefreactor))
          || !write_vec3 (writer, insertion_point)
          || !write_vec3 (writer, u_vector)
          || !write_vec3 (writer, v_vector)
          || !write_f64 (writer, wipeout->image_size.x)
          || !write_f64 (writer, wipeout->image_size.y))
        return 0;
      first_clip_vertex += clip_vertex_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_WIPEOUT_ENTITIES,
      WIPEOUT_ENTITY_RECORD_SIZE, "wipeout_entities", offset, count);
}

static int
write_wipeout_clip_vertex_section (CacheWriter *writer,
                                   const Dwg_Data *dwg,
                                   SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_WIPEOUT *wipeout;
      uint32_t vertex_index;
      if (object->fixedtype != DWG_TYPE_WIPEOUT || !object->tio.entity
          || !(wipeout = object->tio.entity->tio.WIPEOUT))
        continue;
      if (!validate_wipeout_source (writer, wipeout))
        return 0;
      if (count > (uint64_t)MAX_WIPEOUT_CLIP_VERTICES
                      - (uint32_t)wipeout->num_clip_verts)
        {
          set_error (
              writer,
              "WIPEOUT source exceeds its clip-vertex limit");
          return 0;
        }
      for (vertex_index = 0;
           vertex_index < (uint32_t)wipeout->num_clip_verts;
           vertex_index++)
        {
          if (!write_f64 (writer, wipeout->clip_verts[vertex_index].x)
              || !write_f64 (
                  writer, wipeout->clip_verts[vertex_index].y))
            return 0;
        }
      count += (uint32_t)wipeout->num_clip_verts;
    }
  return finish_fixed_section (
      writer, entry, SECTION_WIPEOUT_CLIP_VERTICES,
      WIPEOUT_CLIP_VERTEX_RECORD_SIZE, "wipeout_clip_vertices", offset,
      count);
}

static int
count_gpu_segments (const Dwg_Data *dwg, const CacheTables *tables,
                    LibreDwgGpuLineSummary *summary,
                    OverviewPlan *overview)
{
  GpuSegmentCounter counter;
  uint64_t skipped = 0;
  uint64_t approximated = 0;
  size_t i;
  counter.summary = summary;
  counter.overview = overview;
  if (!iterate_gpu_segments (dwg, tables, NULL, count_gpu_segment,
                             &counter, NULL, &skipped, &approximated))
    return 0;
  summary->skipped_non_finite_segments = skipped;
  summary->approximated_curve_segments = approximated;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_HATCH
          && object->tio.entity
          && object->tio.entity->tio.HATCH
          && hatch_requested_boundary_segments (
                 object->tio.entity->tio.HATCH)
                 > MAX_HATCH_BOUNDARY_SEGMENTS)
        summary->truncated_hatch_entities++;
    }
  return 1;
}

typedef struct
{
  CacheWriter *writer;
  OverviewPlan *overview;
  FILE *file;
  SpatialSegmentRecord *buffer;
  SpatialSortRun *runs;
  size_t buffered;
  size_t run_count;
  size_t run_capacity;
  uint64_t records_written;
  uint64_t source_order;
} SpatialSortBuilder;

static FILE *
open_spatial_temp_file (CacheWriter *writer)
{
  FILE *file = tmpfile ();
  int descriptor;
  int flags;
  if (!file)
    {
      set_error (writer, "cannot create private spatial-sort storage");
      return NULL;
    }
  descriptor = fileno (file);
  flags = descriptor >= 0 ? fcntl (descriptor, F_GETFD) : -1;
  if (descriptor < 0 || fchmod (descriptor, 0600) != 0 || flags < 0
      || fcntl (descriptor, F_SETFD, flags | FD_CLOEXEC) != 0)
    {
      fclose (file);
      set_error (writer, "cannot secure private spatial-sort storage");
      return NULL;
    }
  return file;
}

static void
close_spatial_segment_store (SpatialSegmentStore *store)
{
  if (store->file)
    fclose (store->file);
  memset (store, 0, sizeof (*store));
}

static uint16_t
quantize_morton_axis (double value, double minimum, double maximum)
{
  double span = maximum - minimum;
  double normalized;
  if (!isfinite (span) || span <= 0.0)
    return 0;
  normalized = (value - minimum) / span;
  if (normalized < 0.0)
    normalized = 0.0;
  else if (normalized > 1.0)
    normalized = 1.0;
  return (uint16_t)round (normalized * (double)UINT16_MAX);
}

static uint32_t
interleave_u16 (uint16_t input)
{
  uint32_t value = input;
  value = (value | (value << 8)) & 0x00ff00ffu;
  value = (value | (value << 4)) & 0x0f0f0f0fu;
  value = (value | (value << 2)) & 0x33333333u;
  return (value | (value << 1)) & 0x55555555u;
}

static uint32_t
spatial_morton_key (const LineSegment *segment,
                    const OverviewPlan *overview)
{
  size_t index = overview_group_index (segment, overview);
  const OverviewGroup *group = &overview->groups[index];
  double midpoint_x
      = segment->start[0] * 0.5 + segment->end[0] * 0.5;
  double midpoint_y
      = segment->start[1] * 0.5 + segment->end[1] * 0.5;
  uint16_t x = quantize_morton_axis (
      midpoint_x, group->midpoint_min[0], group->midpoint_max[0]);
  uint16_t y = quantize_morton_axis (
      midpoint_y, group->midpoint_min[1], group->midpoint_max[1]);
  return interleave_u16 (x) | (interleave_u16 (y) << 1);
}

static int
spatial_record_compare (const void *left, const void *right)
{
  const SpatialSegmentRecord *a = (const SpatialSegmentRecord *)left;
  const SpatialSegmentRecord *b = (const SpatialSegmentRecord *)right;
  uint32_t a_group = a->segment.group;
  uint32_t b_group = b->segment.group;
  if (a_group != b_group)
    {
      if (a_group == UINT32_MAX)
        return -1;
      if (b_group == UINT32_MAX)
        return 1;
      return a_group < b_group ? -1 : 1;
    }
  if (a->morton != b->morton)
    return a->morton < b->morton ? -1 : 1;
  if (a->source_order != b->source_order)
    return a->source_order < b->source_order ? -1 : 1;
  return 0;
}

static int
flush_spatial_sort_run (SpatialSortBuilder *builder)
{
  SpatialSortRun *run;
  if (!builder->buffered)
    return 1;
  if (builder->run_count >= builder->run_capacity)
    {
      set_error (builder->writer, "spatial-sort run count is inconsistent");
      return 0;
    }
  qsort (builder->buffer, builder->buffered,
         sizeof (SpatialSegmentRecord), spatial_record_compare);
  run = &builder->runs[builder->run_count++];
  run->start = builder->records_written;
  run->count = builder->buffered;
  if (fwrite (builder->buffer, sizeof (SpatialSegmentRecord),
              builder->buffered, builder->file)
      != builder->buffered)
    {
      set_error (builder->writer, "cannot write spatial-sort run");
      return 0;
    }
  builder->records_written += builder->buffered;
  builder->buffered = 0;
  return 1;
}

static int
spatial_sort_consume (void *context, const LineSegment *segment)
{
  SpatialSortBuilder *builder = (SpatialSortBuilder *)context;
  SpatialSegmentRecord *record;
  size_t index = overview_group_index (segment, builder->overview);
  if (index >= builder->overview->group_count
      || !builder->overview->groups[index].has_midpoint_bounds)
    {
      set_error (builder->writer, "spatial-sort group bounds are missing");
      return 0;
    }
  if (builder->buffered == SPATIAL_SORT_RUN_SEGMENTS
      && !flush_spatial_sort_run (builder))
    return 0;
  record = &builder->buffer[builder->buffered++];
  record->segment = *segment;
  record->source_order = builder->source_order++;
  record->morton = spatial_morton_key (segment, builder->overview);
  record->reserved = 0;
  return 1;
}

static int
read_spatial_records (int descriptor, uint64_t index, size_t count,
                      SpatialSegmentRecord *records)
{
  uint64_t record_size = sizeof (SpatialSegmentRecord);
  uint64_t byte_offset;
  size_t byte_count;
  size_t completed = 0;
  if (index > (uint64_t)INT64_MAX / record_size
      || count > SIZE_MAX / sizeof (SpatialSegmentRecord))
    return 0;
  byte_offset = index * record_size;
  byte_count = count * sizeof (SpatialSegmentRecord);
  while (completed < byte_count)
    {
      ssize_t result = pread (
          descriptor, (uint8_t *)records + completed,
          byte_count - completed, (off_t)(byte_offset + completed));
      if (result < 0 && errno == EINTR)
        continue;
      if (result <= 0)
        return 0;
      completed += (size_t)result;
    }
  return 1;
}

static int
load_spatial_merge_run (CacheWriter *writer, int descriptor,
                        SpatialMergeRun *run)
{
  size_t count
      = run->remaining < SPATIAL_MERGE_BUFFER_RECORDS
            ? (size_t)run->remaining
            : SPATIAL_MERGE_BUFFER_RECORDS;
  if (!count || !read_spatial_records (
                    descriptor, run->next, count, run->buffer))
    {
      set_error (writer, "cannot read spatial-sort run");
      return 0;
    }
  run->next += count;
  run->remaining -= count;
  run->buffered = count;
  run->position = 0;
  return 1;
}

static int
spatial_heap_less (const SpatialMergeRun *runs, size_t left,
                   size_t right)
{
  const SpatialSegmentRecord *a
      = &runs[left].buffer[runs[left].position];
  const SpatialSegmentRecord *b
      = &runs[right].buffer[runs[right].position];
  return spatial_record_compare (a, b) < 0;
}

static void
sift_spatial_heap (size_t *heap, size_t count, size_t root,
                   const SpatialMergeRun *runs)
{
  for (;;)
    {
      size_t left = root * 2u + 1u;
      size_t right = left + 1u;
      size_t smallest = root;
      size_t temporary;
      if (left < count
          && spatial_heap_less (runs, heap[left], heap[smallest]))
        smallest = left;
      if (right < count
          && spatial_heap_less (runs, heap[right], heap[smallest]))
        smallest = right;
      if (smallest == root)
        return;
      temporary = heap[root];
      heap[root] = heap[smallest];
      heap[smallest] = temporary;
      root = smallest;
    }
}

static int
merge_spatial_sort_runs (CacheWriter *writer, FILE *input,
                         const SpatialSortRun *source_runs,
                         size_t run_count, FILE *output,
                         uint64_t expected)
{
  SpatialMergeRun *runs = NULL;
  size_t *heap = NULL;
  size_t heap_count = run_count;
  uint64_t written = 0;
  int descriptor = fileno (input);
  size_t i;
  int success = 0;
  if (descriptor < 0)
    {
      set_error (writer, "cannot open spatial-sort runs");
      return 0;
    }
  if (run_count > SIZE_MAX / sizeof (SpatialMergeRun)
      || run_count > SIZE_MAX / sizeof (size_t))
    {
      set_error (writer, "spatial-sort merge is too large");
      return 0;
    }
  runs = (SpatialMergeRun *)calloc (run_count, sizeof (*runs));
  heap = (size_t *)malloc (run_count * sizeof (*heap));
  if (!runs || !heap)
    {
      set_error (writer, "out of memory while merging spatial-sort runs");
      goto done;
    }
  for (i = 0; i < run_count; i++)
    {
      runs[i].next = source_runs[i].start;
      runs[i].remaining = source_runs[i].count;
      heap[i] = i;
      if (!load_spatial_merge_run (writer, descriptor, &runs[i]))
        goto done;
    }
  for (i = heap_count / 2u; i > 0; i--)
    sift_spatial_heap (heap, heap_count, i - 1u, runs);

  while (heap_count)
    {
      size_t run_index = heap[0];
      SpatialMergeRun *run = &runs[run_index];
      if (fwrite (&run->buffer[run->position],
                  sizeof (SpatialSegmentRecord), 1, output)
          != 1)
        {
          set_error (writer, "cannot write sorted spatial geometry");
          goto done;
        }
      written++;
      run->position++;
      if (run->position == run->buffered)
        {
          if (run->remaining)
            {
              if (!load_spatial_merge_run (writer, descriptor, run))
                goto done;
            }
          else
            {
              heap[0] = heap[--heap_count];
            }
        }
      if (heap_count)
        sift_spatial_heap (heap, heap_count, 0, runs);
    }
  if (written != expected || fflush (output) != 0
      || fseeko (output, 0, SEEK_SET) != 0)
    {
      set_error (writer, "sorted spatial geometry is incomplete");
      goto done;
    }
  success = 1;

done:
  free (heap);
  free (runs);
  return success;
}

static int
build_spatial_segment_store (CacheWriter *writer, const Dwg_Data *dwg,
                             const CacheTables *tables,
                             OverviewPlan *overview, uint64_t total,
                             SpatialSegmentStore *store)
{
  SpatialSortBuilder builder;
  FILE *runs_file = NULL;
  FILE *sorted_file = NULL;
  uint64_t selected = 0;
  uint64_t run_capacity
      = total / SPATIAL_SORT_RUN_SEGMENTS
        + (total % SPATIAL_SORT_RUN_SEGMENTS != 0);
  int success = 0;
  memset (&builder, 0, sizeof (builder));
  memset (store, 0, sizeof (*store));
  if (!total || total > (uint64_t)INT64_MAX
                            / sizeof (SpatialSegmentRecord)
      || run_capacity > SIZE_MAX
      || run_capacity > SIZE_MAX / sizeof (SpatialSortRun))
    {
      set_error (writer, "spatial-sort geometry is too large");
      return 0;
    }
  runs_file = open_spatial_temp_file (writer);
  if (!runs_file)
    goto done;
  sorted_file = open_spatial_temp_file (writer);
  if (!sorted_file)
    goto done;
  builder.buffer = (SpatialSegmentRecord *)malloc (
      SPATIAL_SORT_RUN_SEGMENTS * sizeof (SpatialSegmentRecord));
  builder.runs
      = (SpatialSortRun *)calloc ((size_t)run_capacity,
                                 sizeof (SpatialSortRun));
  if (!builder.buffer || !builder.runs)
    {
      if (!writer->failed)
        set_error (writer, "out of memory while preparing spatial sort");
      goto done;
    }
  builder.writer = writer;
  builder.overview = overview;
  builder.file = runs_file;
  builder.run_capacity = (size_t)run_capacity;
  if (!iterate_gpu_segments (dwg, tables, NULL, spatial_sort_consume,
                             &builder, &selected, NULL, NULL)
      || !flush_spatial_sort_run (&builder)
      || selected != total || builder.records_written != total
      || fflush (runs_file) != 0)
    {
      if (!writer->failed)
        set_error (writer, "cannot prepare complete spatial geometry");
      goto done;
    }
  free (builder.buffer);
  builder.buffer = NULL;
  if (!merge_spatial_sort_runs (
          writer, runs_file, builder.runs, builder.run_count,
          sorted_file, total))
    goto done;
  store->file = sorted_file;
  store->count = total;
  sorted_file = NULL;
  success = 1;

done:
  free (builder.runs);
  free (builder.buffer);
  if (sorted_file)
    fclose (sorted_file);
  if (runs_file)
    fclose (runs_file);
  return success;
}

static int
iterate_spatial_segment_store (CacheWriter *writer,
                               SpatialSegmentStore *store,
                               LineSegmentConsumer consumer, void *context,
                               uint64_t *selected)
{
  SpatialSegmentRecord record;
  uint64_t count;
  if (!store || !store->file || !consumer)
    {
      set_error (writer, "sorted spatial geometry is unavailable");
      return 0;
    }
  clearerr (store->file);
  if (fseeko (store->file, 0, SEEK_SET) != 0)
    {
      set_error (writer, "cannot rewind sorted spatial geometry");
      return 0;
    }
  for (count = 0; count < store->count; count++)
    {
      if (fread (&record, sizeof (record), 1, store->file) != 1)
        {
          set_error (writer, "cannot read sorted spatial geometry");
          return 0;
        }
      if (!consumer (context, &record.segment))
        return 0;
    }
  if (selected)
    *selected = count;
  return 1;
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
      || !write_u32 (writer, builder->batch_flags)
      || !write_u32 (writer, block_index)
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
  builder->batch_flags = 0;
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
  if (segment->approximated_curve)
    builder->batch_flags |= GPU_BATCH_FLAG_APPROXIMATED_CURVE;
  builder->count++;
  return 1;
}

static int
write_batch_pass (CacheWriter *writer, const Dwg_Data *dwg,
                  const CacheTables *tables,
                  LibreDwgGpuLineSummary *summary, OverviewPlan *overview,
                  SpatialSegmentStore *spatial,
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
  if (!(spatial
            ? iterate_spatial_segment_store (
                  writer, spatial, batch_directory_consume, &builder,
                  selected)
            : iterate_gpu_segments (
                  dwg, tables, overview, batch_directory_consume, &builder,
                  selected, NULL, NULL))
      || !write_batch_record (&builder))
    return 0;
  summary->vertices = builder.first_vertex;
  return 1;
}

static int
write_gpu_batch_section (CacheWriter *writer, const Dwg_Data *dwg,
                         const CacheTables *tables,
                         LibreDwgGpuLineSummary *summary,
                         OverviewPlan *overview,
                         SpatialSegmentStore *spatial, SectionEntry *entry,
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
  if (*separate_overview
      && (!spatial || !spatial->file || spatial->count != total))
    {
      set_error (writer, "sorted spatial geometry count is inconsistent");
      return 0;
    }
  before_batches = summary->batches;
  if (*separate_overview)
    {
      if (!write_batch_pass (writer, dwg, tables, summary, overview, NULL,
                             0, 1, &selected))
        return 0;
      summary->overview_segments = selected;
      if (!write_batch_pass (writer, dwg, tables, summary, NULL, spatial,
                             1, 1, NULL))
        return 0;
    }
  else
    {
      summary->overview_segments = total;
      if (!write_batch_pass (writer, dwg, tables, summary, NULL, NULL,
                             0, 0, NULL))
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
  style |= (uint32_t)segment->source_kind
           << GPU_STYLE_SOURCE_KIND_SHIFT;
  if (segment->approximated_curve)
    style |= GPU_STYLE_APPROXIMATED_CURVE;
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
                   SpatialSegmentStore *spatial,
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
  if (!(spatial
            ? iterate_spatial_segment_store (
                  writer, spatial, vertex_consume, &builder, NULL)
            : iterate_gpu_segments (
                  dwg, tables, overview, vertex_consume, &builder, NULL,
                  NULL, NULL))
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
                          OverviewPlan *overview,
                          SpatialSegmentStore *spatial, SectionEntry *entry,
                          int separate_overview)
{
  uint64_t offset;
  uint64_t vertices = 0;
  uint64_t expected = summary->vertices;
  if (!align_writer (writer, &offset))
    return 0;
  if (separate_overview
      && !write_vertex_pass (
          writer, dwg, tables, overview, NULL, &vertices))
    return 0;
  if (!write_vertex_pass (
          writer, dwg, tables, NULL,
          separate_overview ? spatial : NULL, &vertices))
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
  LibreDwgHatchFillSummary hatch_fills;
  OverviewPlan overview;
  SpatialSegmentStore spatial;
  uint64_t body_offset;
  uint64_t file_size;
  uint64_t gpu_segment_count;
  uint32_t wipeout_frame;
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
  memset (&hatch_fills, 0, sizeof (hatch_fills));
  memset (&overview, 0, sizeof (overview));
  memset (&spatial, 0, sizeof (spatial));
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
  counts = count_primitives (dwg, &tables);
  if (!read_drawing_wipeout_frame (&writer, dwg, &wipeout_frame))
    goto done;
  if (!initialize_overview_plan (&tables, &overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot allocate bounded overview plan");
      goto done;
    }
  if (!count_gpu_segments (dwg, &tables, &gpu_lines, &overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot count bounded GPU segments");
      goto done;
    }
  if (!finalize_overview_quotas (&overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot allocate bounded overview quotas");
      goto done;
    }
  if (UINT64_MAX - gpu_lines.model_segments < gpu_lines.block_segments)
    {
      set_error (&writer, "GPU segment count exceeds cache limits");
      goto done;
    }
  gpu_segment_count = gpu_lines.model_segments + gpu_lines.block_segments;
  if (gpu_segment_count > SCENE_OVERVIEW_SEGMENTS
      && !build_spatial_segment_store (
          &writer, dwg, &tables, &overview, gpu_segment_count, &spatial))
    goto done;

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
      || !write_drawing_section (
          &writer, dwg, &counts, source_version, wipeout_frame,
          &sections[0])
      || !write_layer_section (&writer, &tables, &sections[1])
      || !write_block_section (&writer, &tables, &sections[2])
      || !write_text_style_section (&writer, &tables, &sections[3])
      || !write_line_section (&writer, dwg, &tables, &sections[4])
      || !write_arc_section (&writer, dwg, &tables, &sections[5])
      || !write_circle_section (&writer, dwg, &tables, &sections[6])
      || !write_insert_section (&writer, dwg, &tables, &sections[7])
      || !write_polyline_header_section (&writer, dwg, &tables,
                                         &sections[8])
      || !write_polyline_vertex_section (&writer, dwg, &sections[9])
      || !write_ellipse_section (&writer, dwg, &tables, &sections[10])
      || !write_spline_header_section (&writer, dwg, &tables,
                                       &sections[11])
      || !write_spline_knot_section (&writer, dwg, &sections[12])
      || !write_spline_weight_section (&writer, dwg, &sections[13])
      || !write_spline_control_point_section (&writer, dwg,
                                              &sections[14])
      || !write_spline_fit_point_section (&writer, dwg,
                                          &sections[15])
      || !write_text_entity_section (&writer, dwg, &tables,
                                     &sections[16])
      || !write_text_column_height_section (&writer, dwg,
                                            &sections[17])
      || !write_gpu_batch_section (&writer, dwg, &tables, &gpu_lines,
                                   &overview, &spatial, &sections[18],
                                   &separate_overview)
      || !write_gpu_vertex_section (&writer, dwg, &tables, &gpu_lines,
                                    &overview, &spatial, &sections[19],
                                    separate_overview)
      || !write_hatch_entity_section (
          &writer, dwg, &tables, &counts, &hatch_fills,
          &sections[20])
      || !write_hatch_loop_section (&writer, dwg, &sections[21])
      || !write_hatch_vertex_section (&writer, dwg, &sections[22])
      || !write_hatch_gradient_color_section (
          &writer, dwg, &sections[23])
      || !write_hatch_seed_point_section (
          &writer, dwg, &sections[24])
      || !write_hatch_pattern_line_section (
          &writer, dwg, &sections[25])
      || !write_hatch_pattern_dash_section (
          &writer, dwg, &sections[26])
      || !write_point_entity_section (
          &writer, dwg, &tables, &sections[27])
      || !write_solid_entity_section (
          &writer, dwg, &tables, &sections[28])
      || !write_face_entity_section (
          &writer, dwg, &tables, &sections[29])
      || !write_wipeout_entity_section (
          &writer, dwg, &tables, &sections[30])
      || !write_wipeout_clip_vertex_section (
          &writer, dwg, &sections[31])
      || !position (&writer, &file_size)
      || !write_header (
          &writer, file_size, source_size, source_version,
          (uint32_t)LIBREDWG_MAINTENANCE_VERSION (dwg))
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
  report->hatch_fills = hatch_fills;
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
  close_spatial_segment_store (&spatial);
  free_overview_plan (&overview);
  free_tables (&tables);
  return success;
}
