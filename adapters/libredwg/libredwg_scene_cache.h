/*
 * SPDX-License-Identifier: MPL-2.0
 */

#ifndef DWG_VIEWER_LIBREDWG_SCENE_CACHE_H
#define DWG_VIEWER_LIBREDWG_SCENE_CACHE_H

#include <dwg.h>

#include <stddef.h>
#include <stdint.h>

#define LIBREDWG_SCENE_CACHE_VERSION_MAJOR 1u
#define LIBREDWG_SCENE_CACHE_VERSION_MINOR 5u
#define LIBREDWG_SCENE_SECTION_COUNT 20

typedef struct
{
  uint64_t total_entities;
  uint64_t serialized_entities;
  uint64_t deferred_entities;
  uint64_t lines;
  uint64_t arcs;
  uint64_t circles;
  uint64_t inserts;
  uint64_t lwpolylines;
  uint64_t polylines_2d;
  uint64_t polylines_3d;
  uint64_t polyline_vertices;
  uint64_t ellipses;
  uint64_t splines;
  uint64_t spline_knots;
  uint64_t spline_weights;
  uint64_t spline_control_points;
  uint64_t spline_fit_points;
  uint64_t texts;
  uint64_t mtexts;
  uint64_t attribute_definitions;
  uint64_t attributes;
} LibreDwgPrimitiveCounts;

typedef struct
{
  uint64_t model_segments;
  uint64_t block_segments;
  uint64_t overview_segments;
  uint64_t approximated_curve_segments;
  uint64_t hatch_boundary_segments;
  uint64_t truncated_hatch_entities;
  uint64_t skipped_non_finite_segments;
  uint64_t batches;
  uint64_t model_overview_batches;
  uint64_t model_detail_batches;
  uint64_t block_batches;
  uint64_t block_overview_batches;
  uint64_t block_detail_batches;
  uint64_t vertices;
  uint64_t cached_vertex_bytes;
  uint64_t first_frame_vertex_bytes;
  uint64_t full_detail_vertex_bytes;
  uint64_t maximum_batch_bytes;
  double maximum_position_error;
} LibreDwgGpuLineSummary;

typedef struct
{
  const char *name;
  uint64_t records;
  uint64_t bytes;
} LibreDwgSectionSummary;

typedef struct
{
  uint64_t cache_size;
  LibreDwgPrimitiveCounts coverage;
  LibreDwgGpuLineSummary gpu_lines;
  LibreDwgSectionSummary sections[LIBREDWG_SCENE_SECTION_COUNT];
} LibreDwgSceneCacheReport;

int libredwg_write_scene_cache (
    Dwg_Data *dwg, const char *output_path, uint64_t source_size,
    uint32_t source_version, LibreDwgSceneCacheReport *report,
    char *error_message, size_t error_message_size);

#endif
