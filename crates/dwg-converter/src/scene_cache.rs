use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Instant;

use acadrust::entities::{
    AttributeEntity, BoundaryEdge, Dimension, EntityCommon, EntityType, Hatch, HatchPatternLine,
    SplineEdge,
};
use acadrust::types::{Color, Matrix3, Vector3};
use acadrust::CadDocument;
use anyhow::{Context, Result};
use serde::Serialize;

use crate::{duration_ms, engine, peak_rss_bytes, Bounds3, BoundsAccumulator, InputSummary};

pub const CACHE_MAGIC: [u8; 8] = *b"DWGSCN1\0";
pub const CACHE_VERSION_MAJOR: u16 = 1;
pub const CACHE_VERSION_MINOR: u16 = 9;
pub const HEADER_SIZE: u32 = 64;
pub const DIRECTORY_ENTRY_SIZE: u32 = 40;

const DRAWING_RECORD_SIZE: u32 = 80;
const LAYER_RECORD_SIZE: u32 = 40;
const BLOCK_RECORD_SIZE: u32 = 64;
const TEXT_STYLE_RECORD_SIZE: u32 = 96;
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
const TEXT_ENTITY_RECORD_SIZE: u32 = 336;
const TEXT_COLUMN_HEIGHT_RECORD_SIZE: u32 = 8;
const GPU_LINE_BATCH_RECORD_SIZE: u32 = 128;
const GPU_LINE_VERTEX_RECORD_SIZE: u32 = 32;
const HATCH_ENTITY_RECORD_SIZE: u32 = 192;
const HATCH_LOOP_RECORD_SIZE: u32 = 48;
const HATCH_VERTEX_RECORD_SIZE: u32 = 24;
const HATCH_GRADIENT_COLOR_RECORD_SIZE: u32 = 16;
const HATCH_SEED_POINT_RECORD_SIZE: u32 = 16;
const HATCH_PATTERN_LINE_RECORD_SIZE: u32 = 72;
const HATCH_PATTERN_DASH_RECORD_SIZE: u32 = 8;
const POINT_ENTITY_RECORD_SIZE: u32 = 112;
const SOLID_ENTITY_RECORD_SIZE: u32 = 168;
const FACE_ENTITY_RECORD_SIZE: u32 = 136;
const STRING_TABLE_HEADER_SIZE: u64 = 16;
const SECTION_FLAG_STRING_TABLE: u32 = 1;
const MAX_CACHE_STRING_BYTES: u64 = 1024 * 1024;
const GPU_LINE_BATCH_SEGMENTS: usize = 8_192;
const SCENE_OVERVIEW_SEGMENTS: usize = 65_536;
const GPU_BATCH_FLAG_APPROXIMATED_CURVE: u32 = 1;
const GPU_STYLE_INVISIBLE: u32 = 1 << 16;
const GPU_STYLE_SOURCE_KIND_SHIFT: u32 = 17;
const GPU_STYLE_APPROXIMATED_CURVE: u32 = 1 << 21;
const TEXT_FLAG_HAS_ALIGNMENT_POINT: u16 = 1;
const TEXT_FLAG_HAS_RECTANGLE_HEIGHT: u16 = 1 << 1;
const TEXT_FLAG_ANNOTATIVE: u16 = 1 << 2;
const TEXT_FLAG_MULTILINE: u16 = 1 << 3;
const TEXT_FLAG_LOCK_POSITION: u16 = 1 << 4;
const CURVE_MAX_ANGLE_RADIANS: f64 = std::f64::consts::PI / 8.0;
const MAX_CURVE_SEGMENTS: usize = 256;
const SPLINE_SEGMENTS_PER_SPAN: usize = 2;
const MAX_SPLINE_DEGREE: usize = 15;
const MAX_HATCH_BOUNDARY_SEGMENTS: usize = 65_536;
const MAX_HATCH_FILL_VERTICES: usize = 1_048_576;
const MAX_HATCH_AUX_RECORDS: usize = 1_048_576;
const MAX_HATCH_PATTERN_LINES_PER_ENTITY: usize = 4_096;
const MAX_HATCH_PATTERN_DASHES_PER_ENTITY: usize = 65_536;
const MAX_HATCH_PATTERN_LINES: usize = 262_144;
const MAX_HATCH_PATTERN_DASHES: usize = 1_048_576;
const CURVE_EPSILON: f64 = 1.0e-12;
const HATCH_FLAG_SOLID: u32 = 1;
const HATCH_FLAG_ASSOCIATIVE: u32 = 1 << 1;
const HATCH_FLAG_DOUBLE: u32 = 1 << 2;
const HATCH_FLAG_GRADIENT: u32 = 1 << 3;
const HATCH_FLAG_SINGLE_COLOR_GRADIENT: u32 = 1 << 4;
const HATCH_FLAG_TRUNCATED: u32 = 1 << 5;
const HATCH_LOOP_FLAG_APPROXIMATED_CURVE: u32 = 1;

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
    pub gpu_lines: GpuLineSummary,
    pub hatch_fills: HatchFillSummary,
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
    pub dimensions: u64,
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
    pub texts: u64,
    pub mtexts: u64,
    pub attribute_definitions: u64,
    pub attributes: u64,
    pub hatches: u64,
    pub points: u64,
    pub solids: u64,
    pub faces: u64,
}

#[derive(Debug, Clone, Copy)]
struct BlockInstanceTarget {
    index: u32,
    base_point: Vector3,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct GpuLineSummary {
    pub model_segments: u64,
    pub block_segments: u64,
    pub overview_segments: u64,
    pub approximated_curve_segments: u64,
    pub hatch_boundary_segments: u64,
    pub truncated_hatch_entities: u64,
    pub skipped_non_finite_segments: u64,
    pub batches: u64,
    pub model_overview_batches: u64,
    pub model_detail_batches: u64,
    pub block_batches: u64,
    pub block_overview_batches: u64,
    pub block_detail_batches: u64,
    pub vertices: u64,
    pub cached_vertex_bytes: u64,
    pub first_frame_vertex_bytes: u64,
    pub full_detail_vertex_bytes: u64,
    pub maximum_batch_bytes: u64,
    pub maximum_position_error: f64,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct HatchFillSummary {
    pub source_hatches: u64,
    pub solid_hatches: u64,
    pub gradient_hatches: u64,
    pub pattern_hatches: u64,
    pub fill_loops: u64,
    pub fill_vertices: u64,
    pub gradient_colors: u64,
    pub seed_points: u64,
    pub pattern_definition_lines: u64,
    pub pattern_dashes: u64,
    pub truncated_fill_hatches: u64,
    pub truncated_pattern_hatches: u64,
    pub skipped_open_paths: u64,
    pub skipped_invalid_paths: u64,
    pub skipped_invalid_pattern_lines: u64,
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
    TextStyles = 4,
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
    TextEntities = 22,
    TextColumnHeights = 23,
    GpuLineBatches = 30,
    GpuLineVertices = 31,
    HatchEntities = 32,
    HatchLoops = 33,
    HatchVertices = 34,
    HatchGradientColors = 35,
    HatchSeedPoints = 36,
    HatchPatternLines = 37,
    HatchPatternDashes = 38,
    PointEntities = 39,
    SolidEntities = 40,
    FaceEntities = 41,
}

impl SectionKind {
    fn name(self) -> &'static str {
        match self {
            Self::Drawing => "drawing",
            Self::Layers => "layers",
            Self::Blocks => "blocks",
            Self::TextStyles => "text_styles",
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
            Self::TextEntities => "text_entities",
            Self::TextColumnHeights => "text_column_heights",
            Self::GpuLineBatches => "gpu_line_batches",
            Self::GpuLineVertices => "gpu_line_vertices",
            Self::HatchEntities => "hatch_entities",
            Self::HatchLoops => "hatch_loops",
            Self::HatchVertices => "hatch_vertices",
            Self::HatchGradientColors => "hatch_gradient_colors",
            Self::HatchSeedPoints => "hatch_seed_points",
            Self::HatchPatternLines => "hatch_pattern_lines",
            Self::HatchPatternDashes => "hatch_pattern_dashes",
            Self::PointEntities => "point_entities",
            Self::SolidEntities => "solid_entities",
            Self::FaceEntities => "face_entities",
        }
    }

    fn from_code(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::Drawing),
            2 => Some(Self::Layers),
            3 => Some(Self::Blocks),
            4 => Some(Self::TextStyles),
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
            22 => Some(Self::TextEntities),
            23 => Some(Self::TextColumnHeights),
            30 => Some(Self::GpuLineBatches),
            31 => Some(Self::GpuLineVertices),
            32 => Some(Self::HatchEntities),
            33 => Some(Self::HatchLoops),
            34 => Some(Self::HatchVertices),
            35 => Some(Self::HatchGradientColors),
            36 => Some(Self::HatchSeedPoints),
            37 => Some(Self::HatchPatternLines),
            38 => Some(Self::HatchPatternDashes),
            39 => Some(Self::PointEntities),
            40 => Some(Self::SolidEntities),
            41 => Some(Self::FaceEntities),
            _ => None,
        }
    }

    fn expected_record_size(self) -> u32 {
        match self {
            Self::Drawing => DRAWING_RECORD_SIZE,
            Self::Layers => LAYER_RECORD_SIZE,
            Self::Blocks => BLOCK_RECORD_SIZE,
            Self::TextStyles => TEXT_STYLE_RECORD_SIZE,
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
            Self::TextEntities => TEXT_ENTITY_RECORD_SIZE,
            Self::TextColumnHeights => TEXT_COLUMN_HEIGHT_RECORD_SIZE,
            Self::GpuLineBatches => GPU_LINE_BATCH_RECORD_SIZE,
            Self::GpuLineVertices => GPU_LINE_VERTEX_RECORD_SIZE,
            Self::HatchEntities => HATCH_ENTITY_RECORD_SIZE,
            Self::HatchLoops => HATCH_LOOP_RECORD_SIZE,
            Self::HatchVertices => HATCH_VERTEX_RECORD_SIZE,
            Self::HatchGradientColors => HATCH_GRADIENT_COLOR_RECORD_SIZE,
            Self::HatchSeedPoints => HATCH_SEED_POINT_RECORD_SIZE,
            Self::HatchPatternLines => HATCH_PATTERN_LINE_RECORD_SIZE,
            Self::HatchPatternDashes => HATCH_PATTERN_DASH_RECORD_SIZE,
            Self::PointEntities => POINT_ENTITY_RECORD_SIZE,
            Self::SolidEntities => SOLID_ENTITY_RECORD_SIZE,
            Self::FaceEntities => FACE_ENTITY_RECORD_SIZE,
        }
    }

    fn uses_string_table(self) -> bool {
        matches!(
            self,
            Self::Layers
                | Self::Blocks
                | Self::TextStyles
                | Self::TextEntities
                | Self::HatchEntities
        )
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
    gpu_lines: GpuLineSummary,
    hatch_fills: HatchFillSummary,
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

#[derive(Debug)]
struct SourceTextRow<'a> {
    common: &'a EntityCommon,
    kind: u16,
    flags: u16,
    style_name: &'a str,
    value: &'a str,
    tag: &'a str,
    prompt: &'a str,
    linked_handle: u64,
    insertion_point: Vector3,
    alignment_point: Vector3,
    normal: Vector3,
    x_axis_direction: Vector3,
    height: f64,
    width_factor: f64,
    rotation: f64,
    oblique_angle: f64,
    thickness: f64,
    rectangle_width: f64,
    rectangle_height: f64,
    extents_width: f64,
    extents_height: f64,
    line_spacing_factor: f64,
    background_scale: f64,
    background_color: u32,
    background_transparency: i32,
    background_flags: i32,
    source_flags: i32,
    horizontal_alignment: i16,
    vertical_alignment: i16,
    attachment: i16,
    flow_direction: i16,
    line_spacing_style: i16,
    generation_flags: i16,
    field_length: i16,
    mtext_type: i16,
    line_count: i32,
    column_type: i32,
    column_count: i32,
    column_flags: u32,
    column_width: f64,
    column_gutter: f64,
    column_heights: &'a [f64],
}

#[derive(Debug)]
struct HatchEntityRow<'a> {
    hatch: &'a Hatch,
    first_loop: u64,
    loop_count: u64,
    first_gradient_color: u64,
    gradient_color_count: u64,
    first_seed_point: u64,
    seed_point_count: u64,
    definition_line_count: u32,
    truncated: bool,
}

#[derive(Debug)]
struct HatchLoopRow {
    hatch_index: u64,
    path_flags: u32,
    source_path_index: u32,
    first_vertex: u64,
    vertex_count: u64,
    source_edge_count: u32,
    flags: u32,
    signed_area: f64,
}

#[derive(Debug, Clone, Copy)]
struct HatchGradientColorRow {
    value: f64,
    color: u32,
}

#[derive(Debug, Clone, Copy)]
struct HatchPatternLineRow {
    hatch_index: u64,
    source_line_index: u32,
    angle: f64,
    base_point: [f64; 2],
    offset: [f64; 2],
    first_dash: u64,
    dash_count: u32,
}

#[derive(Debug)]
struct HatchSourcePlan<'a> {
    entities: Vec<HatchEntityRow<'a>>,
    loops: Vec<HatchLoopRow>,
    vertices: Vec<Vector3>,
    gradient_colors: Vec<HatchGradientColorRow>,
    seed_points: Vec<[f64; 2]>,
    pattern_lines: Vec<HatchPatternLineRow>,
    pattern_dashes: Vec<f64>,
    summary: HatchFillSummary,
}

enum HatchRingBuild {
    Valid {
        vertices: Vec<Vector3>,
        approximated_curve: bool,
        signed_area: f64,
    },
    Open,
    Invalid,
    Truncated,
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
    let document = engine::parse_acadrust(input)?;
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
        gpu_lines: summary.gpu_lines,
        hatch_fills: summary.hatch_fills,
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

#[cfg(test)]
pub(crate) fn write_test_scene_cache(path: &Path, source_size: u64) -> Result<()> {
    let output = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut writer = BufWriter::new(output);
    write_scene_cache(&mut writer, &CadDocument::new(), source_size)?;
    writer.flush()?;
    drop(writer);
    validate_scene_cache(path)?;
    Ok(())
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
    if minor_version >= 2 {
        required.extend([SectionKind::GpuLineBatches, SectionKind::GpuLineVertices]);
    }
    if minor_version >= 4 {
        required.extend([
            SectionKind::TextStyles,
            SectionKind::TextEntities,
            SectionKind::TextColumnHeights,
        ]);
    }
    if minor_version >= 6 {
        required.extend([
            SectionKind::HatchEntities,
            SectionKind::HatchLoops,
            SectionKind::HatchVertices,
            SectionKind::HatchGradientColors,
            SectionKind::HatchSeedPoints,
        ]);
    }
    if minor_version >= 7 {
        required.extend([
            SectionKind::HatchPatternLines,
            SectionKind::HatchPatternDashes,
        ]);
    }
    if minor_version >= 8 {
        required.extend([SectionKind::PointEntities, SectionKind::SolidEntities]);
    }
    if minor_version >= 9 {
        required.push(SectionKind::FaceEntities);
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
        let mut record = [0_u8; TEXT_ENTITY_RECORD_SIZE as usize];
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
            SectionKind::TextStyles => {
                for reference_offset in [8, 16, 24, 32] {
                    validate_utf8_reference(
                        reader,
                        entry,
                        string_offset,
                        slice_u32(&record, reference_offset),
                        slice_u32(&record, reference_offset + 4),
                    )?;
                }
            }
            SectionKind::TextEntities => {
                for reference_offset in [40, 48, 56] {
                    validate_utf8_reference(
                        reader,
                        entry,
                        string_offset,
                        slice_u32(&record, reference_offset),
                        slice_u32(&record, reference_offset + 4),
                    )?;
                }
            }
            SectionKind::HatchEntities => {
                for reference_offset in [32, 40] {
                    validate_utf8_reference(
                        reader,
                        entry,
                        string_offset,
                        slice_u32(&record, reference_offset),
                        slice_u32(&record, reference_offset + 4),
                    )?;
                }
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
    if let Some(texts) = find_section(entries, SectionKind::TextEntities) {
        let styles = find_section(entries, SectionKind::TextStyles)
            .context("text entities exist without a text-style table")?;
        let column_heights = find_section(entries, SectionKind::TextColumnHeights)
            .context("text entities exist without a column-height pool")?;
        for index in 0..texts.record_count {
            let mut record = [0_u8; TEXT_ENTITY_RECORD_SIZE as usize];
            read_record(reader, texts, index, &mut record)?;
            let style_index = slice_u32(&record, 36);
            if style_index != u32::MAX && u64::from(style_index) >= styles.record_count {
                anyhow::bail!("text entity references an invalid text style");
            }
            validate_pool_range(
                "text column heights",
                slice_u64(&record, 320),
                slice_u64(&record, 328),
                column_heights.record_count,
            )?;
        }
    }

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

    if let Some(hatches) = find_section(entries, SectionKind::HatchEntities) {
        let loops = find_section(entries, SectionKind::HatchLoops)
            .context("HATCH entities exist without a loop pool")?;
        let vertices = find_section(entries, SectionKind::HatchVertices)
            .context("HATCH entities exist without a vertex pool")?;
        let colors = find_section(entries, SectionKind::HatchGradientColors)
            .context("HATCH entities exist without a gradient-color pool")?;
        let seeds = find_section(entries, SectionKind::HatchSeedPoints)
            .context("HATCH entities exist without a seed-point pool")?;
        let mut expected_first_loop = 0_u64;
        let mut expected_first_color = 0_u64;
        let mut expected_first_seed = 0_u64;

        for hatch_index in 0..hatches.record_count {
            let mut record = [0_u8; HATCH_ENTITY_RECORD_SIZE as usize];
            read_record(reader, hatches, hatch_index, &mut record)?;
            let flags = slice_u32(&record, 48);
            let style = slice_u16(&record, 52);
            let pattern_type = slice_u16(&record, 54);
            if flags
                & !(HATCH_FLAG_SOLID
                    | HATCH_FLAG_ASSOCIATIVE
                    | HATCH_FLAG_DOUBLE
                    | HATCH_FLAG_GRADIENT
                    | HATCH_FLAG_SINGLE_COLOR_GRADIENT
                    | HATCH_FLAG_TRUNCATED)
                != 0
                || style > 2
                || pattern_type > 2
            {
                anyhow::bail!("HATCH entity contains unsupported flags or enum values");
            }

            let first_loop = slice_u64(&record, 56);
            let loop_count = slice_u64(&record, 64);
            let first_color = slice_u64(&record, 72);
            let color_count = slice_u64(&record, 80);
            let first_seed = slice_u64(&record, 168);
            let seed_count = slice_u64(&record, 176);
            if first_loop != expected_first_loop
                || first_color != expected_first_color
                || first_seed != expected_first_seed
            {
                anyhow::bail!("HATCH source pool ranges are not contiguous");
            }
            validate_pool_range("HATCH loops", first_loop, loop_count, loops.record_count)?;
            validate_pool_range(
                "HATCH gradient colors",
                first_color,
                color_count,
                colors.record_count,
            )?;
            validate_pool_range(
                "HATCH seed points",
                first_seed,
                seed_count,
                seeds.record_count,
            )?;
            expected_first_loop = first_loop
                .checked_add(loop_count)
                .context("HATCH loop range overflow")?;
            expected_first_color = first_color
                .checked_add(color_count)
                .context("HATCH gradient-color range overflow")?;
            expected_first_seed = first_seed
                .checked_add(seed_count)
                .context("HATCH seed-point range overflow")?;

            for coordinate_offset in [88, 96, 104, 112, 120, 128, 136, 144, 152, 160] {
                if !slice_f64(&record, coordinate_offset).is_finite() {
                    anyhow::bail!("HATCH entity contains a non-finite scalar");
                }
            }
            let normal_length_squared = [96, 104, 112]
                .into_iter()
                .map(|offset| slice_f64(&record, offset).powi(2))
                .sum::<f64>();
            if !normal_length_squared.is_finite() || normal_length_squared <= CURVE_EPSILON {
                anyhow::bail!("HATCH entity contains an invalid normal");
            }

            for loop_index in first_loop..expected_first_loop {
                let mut loop_record = [0_u8; HATCH_LOOP_RECORD_SIZE as usize];
                read_record(reader, loops, loop_index, &mut loop_record)?;
                if slice_u64(&loop_record, 0) != hatch_index {
                    anyhow::bail!("HATCH loop references an invalid source entity");
                }
            }
        }
        if expected_first_loop != loops.record_count
            || expected_first_color != colors.record_count
            || expected_first_seed != seeds.record_count
        {
            anyhow::bail!("HATCH source pools are not fully covered");
        }

        let mut expected_first_vertex = 0_u64;
        for loop_index in 0..loops.record_count {
            let mut record = [0_u8; HATCH_LOOP_RECORD_SIZE as usize];
            read_record(reader, loops, loop_index, &mut record)?;
            let hatch_index = slice_u64(&record, 0);
            let path_flags = slice_u32(&record, 8);
            let first_vertex = slice_u64(&record, 16);
            let vertex_count = slice_u64(&record, 24);
            let flags = slice_u32(&record, 36);
            let signed_area = slice_f64(&record, 40);
            if hatch_index >= hatches.record_count
                || path_flags & 32 != 0
                || first_vertex != expected_first_vertex
                || vertex_count < 3
                || flags & !HATCH_LOOP_FLAG_APPROXIMATED_CURVE != 0
                || !signed_area.is_finite()
                || signed_area.abs() <= 1.0e-18
            {
                anyhow::bail!("HATCH loop contains invalid metadata");
            }
            validate_pool_range(
                "HATCH vertices",
                first_vertex,
                vertex_count,
                vertices.record_count,
            )?;
            expected_first_vertex = first_vertex
                .checked_add(vertex_count)
                .context("HATCH vertex range overflow")?;
        }
        if expected_first_vertex != vertices.record_count {
            anyhow::bail!("HATCH vertex pool is not fully covered");
        }

        for vertex_index in 0..vertices.record_count {
            let mut record = [0_u8; HATCH_VERTEX_RECORD_SIZE as usize];
            read_record(reader, vertices, vertex_index, &mut record)?;
            if [0, 8, 16]
                .into_iter()
                .any(|offset| !slice_f64(&record, offset).is_finite())
            {
                anyhow::bail!("HATCH vertex contains a non-finite coordinate");
            }
        }
        for color_index in 0..colors.record_count {
            let mut record = [0_u8; HATCH_GRADIENT_COLOR_RECORD_SIZE as usize];
            read_record(reader, colors, color_index, &mut record)?;
            if !slice_f64(&record, 0).is_finite() {
                anyhow::bail!("HATCH gradient color contains a non-finite position");
            }
        }
        for seed_index in 0..seeds.record_count {
            let mut record = [0_u8; HATCH_SEED_POINT_RECORD_SIZE as usize];
            read_record(reader, seeds, seed_index, &mut record)?;
            if !slice_f64(&record, 0).is_finite() || !slice_f64(&record, 8).is_finite() {
                anyhow::bail!("HATCH seed point contains a non-finite coordinate");
            }
        }
    }

    if let Some(pattern_lines) = find_section(entries, SectionKind::HatchPatternLines) {
        let hatches = find_section(entries, SectionKind::HatchEntities)
            .context("HATCH pattern lines exist without HATCH entities")?;
        let pattern_dashes = find_section(entries, SectionKind::HatchPatternDashes)
            .context("HATCH pattern lines exist without a dash pool")?;
        if pattern_lines.record_count > MAX_HATCH_PATTERN_LINES as u64
            || pattern_dashes.record_count > MAX_HATCH_PATTERN_DASHES as u64
        {
            anyhow::bail!("HATCH pattern source pool exceeds its record limit");
        }
        let mut expected_first_dash = 0_u64;
        let mut previous_hatch_index = None;
        let mut previous_source_line_index = None;
        let mut source_definition_count = 0_u32;
        let mut entity_line_count = 0_u64;
        let mut entity_dash_count = 0_u64;

        for line_index in 0..pattern_lines.record_count {
            let mut record = [0_u8; HATCH_PATTERN_LINE_RECORD_SIZE as usize];
            read_record(reader, pattern_lines, line_index, &mut record)?;
            let hatch_index = slice_u64(&record, 0);
            let source_line_index = slice_u32(&record, 8);
            let flags = slice_u32(&record, 12);
            let first_dash = slice_u64(&record, 56);
            let dash_count = u64::from(slice_u32(&record, 64));
            let reserved = slice_u32(&record, 68);
            if hatch_index >= hatches.record_count || flags != 0 || reserved != 0 {
                anyhow::bail!("HATCH pattern line contains invalid metadata");
            }
            if previous_hatch_index.is_some_and(|previous| hatch_index < previous) {
                anyhow::bail!("HATCH pattern lines are not grouped by source entity");
            }
            if previous_hatch_index != Some(hatch_index) {
                let mut hatch_record = [0_u8; HATCH_ENTITY_RECORD_SIZE as usize];
                read_record(reader, hatches, hatch_index, &mut hatch_record)?;
                source_definition_count = slice_u32(&hatch_record, 188);
                previous_source_line_index = None;
                entity_line_count = 0;
                entity_dash_count = 0;
            }
            entity_line_count = entity_line_count
                .checked_add(1)
                .context("HATCH pattern line count overflow")?;
            entity_dash_count = entity_dash_count
                .checked_add(dash_count)
                .context("HATCH pattern dash count overflow")?;
            if source_line_index >= source_definition_count
                || previous_source_line_index.is_some_and(|previous| source_line_index <= previous)
                || entity_line_count > MAX_HATCH_PATTERN_LINES_PER_ENTITY as u64
                || entity_dash_count > MAX_HATCH_PATTERN_DASHES_PER_ENTITY as u64
                || first_dash != expected_first_dash
                || [16, 24, 32, 40, 48]
                    .into_iter()
                    .any(|offset| !slice_f64(&record, offset).is_finite())
            {
                anyhow::bail!("HATCH pattern line contains invalid source data");
            }
            validate_pool_range(
                "HATCH pattern dashes",
                first_dash,
                dash_count,
                pattern_dashes.record_count,
            )?;
            expected_first_dash = first_dash
                .checked_add(dash_count)
                .context("HATCH pattern dash range overflow")?;
            previous_hatch_index = Some(hatch_index);
            previous_source_line_index = Some(source_line_index);
        }
        if expected_first_dash != pattern_dashes.record_count {
            anyhow::bail!("HATCH pattern dash pool is not fully covered");
        }
        for dash_index in 0..pattern_dashes.record_count {
            let mut record = [0_u8; HATCH_PATTERN_DASH_RECORD_SIZE as usize];
            read_record(reader, pattern_dashes, dash_index, &mut record)?;
            if !slice_f64(&record, 0).is_finite() {
                anyhow::bail!("HATCH pattern dash contains a non-finite length");
            }
        }
    }

    if let Some(points) = find_section(entries, SectionKind::PointEntities) {
        let layers = find_section(entries, SectionKind::Layers)
            .context("POINT entities exist without a layer table")?;
        for index in 0..points.record_count {
            let mut record = [0_u8; POINT_ENTITY_RECORD_SIZE as usize];
            read_record(reader, points, index, &mut record)?;
            validate_primitive_common(&record, layers.record_count, "POINT")?;
            if slice_u16(&record, 106) != 0 || slice_u32(&record, 108) != 0 {
                anyhow::bail!("POINT entity has nonzero reserved metadata");
            }
            if [32, 40, 48, 56, 64, 72, 80, 88, 96]
                .into_iter()
                .any(|offset| !slice_f64(&record, offset).is_finite())
            {
                anyhow::bail!("POINT entity contains a non-finite value");
            }
            let normal_length_squared = [56, 64, 72]
                .into_iter()
                .map(|offset| slice_f64(&record, offset).powi(2))
                .sum::<f64>();
            if !normal_length_squared.is_finite() || normal_length_squared <= CURVE_EPSILON {
                anyhow::bail!("POINT entity has an invalid normal");
            }
        }
    }

    if let Some(solids) = find_section(entries, SectionKind::SolidEntities) {
        let layers = find_section(entries, SectionKind::Layers)
            .context("SOLID entities exist without a layer table")?;
        for index in 0..solids.record_count {
            let mut record = [0_u8; SOLID_ENTITY_RECORD_SIZE as usize];
            read_record(reader, solids, index, &mut record)?;
            validate_primitive_common(&record, layers.record_count, "SOLID")?;
            if slice_u32(&record, 32) & !1 != 0 || slice_u32(&record, 36) != 0 {
                anyhow::bail!("SOLID entity has invalid flags or reserved metadata");
            }
            if (40..=160)
                .step_by(8)
                .any(|offset| !slice_f64(&record, offset).is_finite())
            {
                anyhow::bail!("SOLID entity contains a non-finite value");
            }
            let normal_length_squared = [136, 144, 152]
                .into_iter()
                .map(|offset| slice_f64(&record, offset).powi(2))
                .sum::<f64>();
            if !normal_length_squared.is_finite() || normal_length_squared <= CURVE_EPSILON {
                anyhow::bail!("SOLID entity has an invalid normal");
            }
        }
    }

    if let Some(faces) = find_section(entries, SectionKind::FaceEntities) {
        let layers = find_section(entries, SectionKind::Layers)
            .context("3DFACE entities exist without a layer table")?;
        for index in 0..faces.record_count {
            let mut record = [0_u8; FACE_ENTITY_RECORD_SIZE as usize];
            read_record(reader, faces, index, &mut record)?;
            validate_primitive_common(&record, layers.record_count, "3DFACE")?;
            if slice_u32(&record, 32) & !0xf != 0 || slice_u32(&record, 36) != 0 {
                anyhow::bail!("3DFACE entity has invalid flags or reserved metadata");
            }
            if (40..136)
                .step_by(8)
                .any(|offset| !slice_f64(&record, offset).is_finite())
            {
                anyhow::bail!("3DFACE entity contains a non-finite coordinate");
            }
        }
    }

    if let Some(batches) = find_section(entries, SectionKind::GpuLineBatches) {
        let vertices = find_section(entries, SectionKind::GpuLineVertices)
            .context("GPU line batches exist without a vertex pool")?;
        let blocks = find_section(entries, SectionKind::Blocks)
            .context("GPU line batches exist without a block table")?;
        let mut expected_first_vertex = 0_u64;
        let mut detail_lod_started = false;

        for index in 0..batches.record_count {
            let mut record = [0_u8; GPU_LINE_BATCH_RECORD_SIZE as usize];
            read_record(reader, batches, index, &mut record)?;

            if u64::from(slice_u32(&record, 0)) != index {
                anyhow::bail!("GPU line batch IDs are not sequential");
            }

            let batch_kind = slice_u16(&record, 4);
            let lod_level = slice_u16(&record, 6);
            let flags = slice_u32(&record, 8);
            let block_index = slice_u32(&record, 12);
            if lod_level > 1 {
                anyhow::bail!("GPU line batch has an unsupported LOD level");
            }
            if detail_lod_started && lod_level == 0 {
                anyhow::bail!("GPU overview batches are not contiguous");
            }
            detail_lod_started |= lod_level == 1;
            if flags & !GPU_BATCH_FLAG_APPROXIMATED_CURVE != 0 {
                anyhow::bail!("GPU line batch has unsupported flags");
            }
            match batch_kind {
                0 => {
                    if lod_level != 0 || block_index != u32::MAX {
                        anyhow::bail!("model overview GPU batch metadata is inconsistent");
                    }
                }
                1 => {
                    if lod_level > 1 || block_index != u32::MAX {
                        anyhow::bail!("model detail GPU batch metadata is inconsistent");
                    }
                }
                2 => {
                    if u64::from(block_index) >= blocks.record_count {
                        anyhow::bail!("block GPU batch references an invalid block");
                    }
                }
                _ => anyhow::bail!("GPU line batch has an unknown kind"),
            }

            let first_vertex = slice_u64(&record, 16);
            let vertex_count = slice_u64(&record, 24);
            let segment_count = u64::from(slice_u32(&record, 32));
            if first_vertex != expected_first_vertex {
                anyhow::bail!("GPU line vertex ranges are not contiguous");
            }
            let expected_vertex_count = segment_count
                .checked_mul(2)
                .context("GPU line segment count overflow")?;
            if vertex_count != expected_vertex_count {
                anyhow::bail!("GPU line batch vertex count does not match its segments");
            }
            validate_pool_range(
                "GPU line vertices",
                first_vertex,
                vertex_count,
                vertices.record_count,
            )?;
            expected_first_vertex = first_vertex
                .checked_add(vertex_count)
                .context("GPU line vertex range overflow")?;

            for coordinate_offset in [40, 48, 56, 64, 72, 80, 88, 96, 104] {
                if !slice_f64(&record, coordinate_offset).is_finite() {
                    anyhow::bail!("GPU line batch contains a non-finite coordinate");
                }
            }
            for axis in 0..3 {
                if slice_f64(&record, 64 + axis * 8) > slice_f64(&record, 88 + axis * 8) {
                    anyhow::bail!("GPU line batch has inverted bounds");
                }
            }
            let maximum_error = slice_f32(&record, 112);
            if !maximum_error.is_finite() || maximum_error < 0.0 {
                anyhow::bail!("GPU line batch has an invalid position error");
            }
        }

        if expected_first_vertex != vertices.record_count {
            anyhow::bail!("GPU line vertex pool is not fully covered by its batches");
        }
    }
    Ok(())
}

fn validate_primitive_common(record: &[u8], layer_count: u64, entity_name: &str) -> Result<()> {
    let layer_index = slice_u32(record, 16);
    if layer_index != u32::MAX && u64::from(layer_index) >= layer_count {
        anyhow::bail!("{entity_name} entity references an invalid layer");
    }
    if slice_u16(record, 26) & !1 != 0 || slice_u32(record, 28) != 0 {
        anyhow::bail!("{entity_name} entity has invalid common metadata");
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
        .checked_add(if section.flags & SECTION_FLAG_STRING_TABLE != 0 {
            STRING_TABLE_HEADER_SIZE
        } else {
            0
        })
        .context("record section-header offset overflow")?
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
    let section_count = 30_u32;
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
    let block_targets = collect_block_instance_targets(document)?;
    let counts = PrimitiveCounts::from_document(document, &block_targets);
    let text_style_indices: HashMap<String, u32> = document
        .text_styles
        .iter()
        .enumerate()
        .map(|(index, style)| -> Result<_> {
            Ok((
                style.name.to_uppercase(),
                u32::try_from(index).context("too many text styles for scene cache")?,
            ))
        })
        .collect::<Result<_>>()?;

    let mut sections = Vec::with_capacity(section_count as usize);
    sections.push(write_drawing_section(writer, document, &counts)?);
    sections.push(write_layer_section(writer, document)?);
    sections.push(write_block_section(writer, document)?);
    sections.push(write_text_style_section(writer, document)?);
    sections.push(write_line_section(writer, document, &layer_indices)?);
    sections.push(write_arc_section(writer, document, &layer_indices)?);
    sections.push(write_circle_section(writer, document, &layer_indices)?);
    sections.push(write_insert_section(
        writer,
        document,
        &layer_indices,
        &block_targets,
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
    sections.push(write_text_entity_section(
        writer,
        document,
        &layer_indices,
        &text_style_indices,
    )?);
    sections.push(write_text_column_height_section(writer, document)?);
    let gpu_line_plan = build_gpu_line_plan(document)?;
    sections.push(write_gpu_line_batch_section(writer, &gpu_line_plan)?);
    sections.push(write_gpu_line_vertex_section(
        writer,
        &gpu_line_plan,
        &layer_indices,
    )?);
    let gpu_lines = gpu_line_plan.summary;
    drop(gpu_line_plan);
    let hatch_plan = build_hatch_source_plan(document)?;
    sections.push(write_hatch_entity_section(
        writer,
        &hatch_plan,
        &layer_indices,
    )?);
    sections.push(write_hatch_loop_section(writer, &hatch_plan)?);
    sections.push(write_hatch_vertex_section(writer, &hatch_plan)?);
    sections.push(write_hatch_gradient_color_section(writer, &hatch_plan)?);
    sections.push(write_hatch_seed_point_section(writer, &hatch_plan)?);
    sections.push(write_hatch_pattern_line_section(writer, &hatch_plan)?);
    sections.push(write_hatch_pattern_dash_section(writer, &hatch_plan)?);
    let hatch_fills = hatch_plan.summary;
    sections.push(write_point_entity_section(
        writer,
        document,
        &layer_indices,
    )?);
    sections.push(write_solid_entity_section(
        writer,
        document,
        &layer_indices,
    )?);
    sections.push(write_face_entity_section(writer, document, &layer_indices)?);

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

    Ok(CacheWriteSummary {
        counts,
        gpu_lines,
        hatch_fills,
        sections,
    })
}

impl PrimitiveCounts {
    fn from_document(
        document: &CadDocument,
        block_targets: &HashMap<String, BlockInstanceTarget>,
    ) -> Self {
        let mut counts = Self {
            total_entities: document.entity_count() as u64,
            ..Self::default()
        };
        for entity in document.entities() {
            match entity {
                EntityType::Line(_) => counts.lines += 1,
                EntityType::Arc(_) => counts.arcs += 1,
                EntityType::Circle(_) => counts.circles += 1,
                EntityType::Insert(insert) => {
                    counts.inserts += 1;
                    counts.attributes += insert.attributes.len() as u64;
                }
                EntityType::Dimension(dimension) => {
                    if dimension_instance_target(dimension, block_targets).is_some() {
                        counts.dimensions += 1;
                    }
                }
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
                EntityType::Text(_) => counts.texts += 1,
                EntityType::MText(_) => counts.mtexts += 1,
                EntityType::AttributeDefinition(_) => counts.attribute_definitions += 1,
                EntityType::AttributeEntity(_) => counts.attributes += 1,
                EntityType::Hatch(_) => counts.hatches += 1,
                EntityType::Point(_) => counts.points += 1,
                EntityType::Solid(_) => counts.solids += 1,
                EntityType::Face3D(_) => counts.faces += 1,
                _ => {}
            }
        }
        counts.serialized_entities = counts.lines
            + counts.arcs
            + counts.circles
            + counts.inserts
            + counts.dimensions
            + counts.lwpolylines
            + counts.polylines_2d
            + counts.polylines_3d
            + counts.ellipses
            + counts.splines
            + counts.texts
            + counts.mtexts
            + counts.attribute_definitions
            + counts.hatches
            + counts.points
            + counts.solids
            + counts.faces;
        counts.deferred_entities = counts
            .total_entities
            .saturating_sub(counts.serialized_entities);
        counts
    }
}

fn collect_block_instance_targets(
    document: &CadDocument,
) -> Result<HashMap<String, BlockInstanceTarget>> {
    document
        .block_records
        .iter()
        .enumerate()
        .map(|(index, block)| -> Result<_> {
            Ok((
                block.name.to_uppercase(),
                BlockInstanceTarget {
                    index: u32::try_from(index).context("too many blocks for scene cache")?,
                    base_point: block.base_point,
                },
            ))
        })
        .collect()
}

fn dimension_instance_target(
    dimension: &Dimension,
    block_targets: &HashMap<String, BlockInstanceTarget>,
) -> Option<BlockInstanceTarget> {
    let target = block_targets
        .get(&dimension.base().block_name.to_uppercase())
        .copied()?;
    vector_is_finite(target.base_point).then_some(target)
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

fn write_text_style_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    struct TextStyleRow {
        handle: u64,
        name: (u32, u32),
        font_file: (u32, u32),
        big_font_file: (u32, u32),
        true_type_font: (u32, u32),
        flags: u32,
        height: f64,
        width_factor: f64,
        oblique_angle: f64,
        last_height: f64,
    }

    let offset = aligned_position(writer)?;
    let mut strings = Vec::new();
    let mut rows = Vec::with_capacity(document.text_styles.len());
    for style in document.text_styles.iter() {
        let mut flags = 0_u32;
        if style.flags.backward {
            flags |= 1;
        }
        if style.flags.upside_down {
            flags |= 1 << 1;
        }
        if style.xref_dependent {
            flags |= 1 << 2;
        }
        if style.annotative {
            flags |= 1 << 3;
        }
        rows.push(TextStyleRow {
            handle: style.handle.value(),
            name: push_string(&mut strings, &style.name)?,
            font_file: push_string(&mut strings, &style.font_file)?,
            big_font_file: push_string(&mut strings, &style.big_font_file)?,
            true_type_font: push_string(&mut strings, &style.true_type_font)?,
            flags,
            height: style.height,
            width_factor: style.width_factor,
            oblique_angle: style.oblique_angle,
            last_height: style.last_height,
        });
    }

    let string_offset =
        STRING_TABLE_HEADER_SIZE + u64::try_from(rows.len())? * u64::from(TEXT_STYLE_RECORD_SIZE);
    write_u32(writer, u32::try_from(rows.len())?)?;
    write_u32(writer, TEXT_STYLE_RECORD_SIZE)?;
    write_u64(writer, string_offset)?;
    for row in rows {
        write_u64(writer, row.handle)?;
        for reference in [
            row.name,
            row.font_file,
            row.big_font_file,
            row.true_type_font,
        ] {
            write_u32(writer, reference.0)?;
            write_u32(writer, reference.1)?;
        }
        write_u32(writer, row.flags)?;
        write_u32(writer, 0)?;
        write_f64(writer, row.height)?;
        write_f64(writer, row.width_factor)?;
        write_f64(writer, row.oblique_angle)?;
        write_f64(writer, row.last_height)?;
        write_u64(writer, 0)?;
        write_u64(writer, 0)?;
    }
    writer.write_all(&strings)?;

    finish_variable_section(
        writer,
        SectionKind::TextStyles,
        TEXT_STYLE_RECORD_SIZE,
        offset,
        document.text_styles.len() as u64,
        SECTION_FLAG_STRING_TABLE,
    )
}

fn write_text_entity_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
    text_style_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let rows = collect_source_text_rows(document);
    let offset = aligned_position(writer)?;
    let mut strings = Vec::new();
    let mut references = Vec::with_capacity(rows.len());
    for row in &rows {
        references.push([
            push_string(&mut strings, row.value)?,
            push_string(&mut strings, row.tag)?,
            push_string(&mut strings, row.prompt)?,
        ]);
    }

    let string_offset =
        STRING_TABLE_HEADER_SIZE + u64::try_from(rows.len())? * u64::from(TEXT_ENTITY_RECORD_SIZE);
    write_u32(writer, u32::try_from(rows.len())?)?;
    write_u32(writer, TEXT_ENTITY_RECORD_SIZE)?;
    write_u64(writer, string_offset)?;

    let mut first_column_height = 0_u64;
    for (row, string_references) in rows.iter().zip(references) {
        write_common_data(writer, row.common, layer_indices)?;
        write_u16(writer, row.kind)?;
        write_u16(writer, row.flags)?;
        write_u32(
            writer,
            text_style_indices
                .get(&row.style_name.to_uppercase())
                .copied()
                .unwrap_or(u32::MAX),
        )?;
        for reference in string_references {
            write_u32(writer, reference.0)?;
            write_u32(writer, reference.1)?;
        }
        write_u64(writer, row.linked_handle)?;
        write_vec3(writer, row.insertion_point)?;
        write_vec3(writer, row.alignment_point)?;
        write_vec3(writer, row.normal)?;
        write_vec3(writer, row.x_axis_direction)?;
        for value in [
            row.height,
            row.width_factor,
            row.rotation,
            row.oblique_angle,
            row.thickness,
            row.rectangle_width,
            row.rectangle_height,
            row.extents_width,
            row.extents_height,
            row.line_spacing_factor,
            row.background_scale,
        ] {
            write_f64(writer, value)?;
        }
        write_u32(writer, row.background_color)?;
        write_i32(writer, row.background_transparency)?;
        write_i32(writer, row.background_flags)?;
        write_i32(writer, row.source_flags)?;
        for value in [
            row.horizontal_alignment,
            row.vertical_alignment,
            row.attachment,
            row.flow_direction,
            row.line_spacing_style,
            row.generation_flags,
            row.field_length,
            row.mtext_type,
        ] {
            write_i16(writer, value)?;
        }
        write_i32(writer, row.line_count)?;
        write_i32(writer, row.column_type)?;
        write_i32(writer, row.column_count)?;
        write_u32(writer, row.column_flags)?;
        write_f64(writer, row.column_width)?;
        write_f64(writer, row.column_gutter)?;
        write_u64(writer, first_column_height)?;
        write_u64(writer, u64::try_from(row.column_heights.len())?)?;
        first_column_height = first_column_height
            .checked_add(u64::try_from(row.column_heights.len())?)
            .context("too many text column heights for scene cache")?;
    }
    writer.write_all(&strings)?;

    finish_variable_section(
        writer,
        SectionKind::TextEntities,
        TEXT_ENTITY_RECORD_SIZE,
        offset,
        rows.len() as u64,
        SECTION_FLAG_STRING_TABLE,
    )
}

fn write_text_column_height_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for row in collect_source_text_rows(document) {
        for value in row.column_heights {
            write_f64(writer, *value)?;
            count += 1;
        }
    }
    finish_fixed_section(
        writer,
        SectionKind::TextColumnHeights,
        TEXT_COLUMN_HEIGHT_RECORD_SIZE,
        offset,
        count,
    )
}

fn collect_source_text_rows(document: &CadDocument) -> Vec<SourceTextRow<'_>> {
    let mut rows = Vec::new();
    for entity in document.entities() {
        match entity {
            EntityType::Text(text) => {
                let mut flags = 0_u16;
                let alignment_point = text.alignment_point.unwrap_or(Vector3::ZERO);
                if text.alignment_point.is_some() {
                    flags |= TEXT_FLAG_HAS_ALIGNMENT_POINT;
                }
                rows.push(SourceTextRow {
                    common: &text.common,
                    kind: 0,
                    flags,
                    style_name: &text.style,
                    value: &text.value,
                    tag: "",
                    prompt: "",
                    linked_handle: 0,
                    insertion_point: text.insertion_point,
                    alignment_point,
                    normal: text.normal,
                    x_axis_direction: Vector3::new(text.rotation.cos(), text.rotation.sin(), 0.0),
                    height: text.height,
                    width_factor: text.width_factor,
                    rotation: text.rotation,
                    oblique_angle: text.oblique_angle,
                    thickness: text.thickness,
                    rectangle_width: 0.0,
                    rectangle_height: 0.0,
                    extents_width: 0.0,
                    extents_height: 0.0,
                    line_spacing_factor: 0.0,
                    background_scale: 0.0,
                    background_color: 0,
                    background_transparency: 0,
                    background_flags: 0,
                    source_flags: 0,
                    horizontal_alignment: text.horizontal_alignment as i16,
                    vertical_alignment: text.vertical_alignment as i16,
                    attachment: 0,
                    flow_direction: 0,
                    line_spacing_style: 0,
                    generation_flags: text.generation_flags,
                    field_length: 0,
                    mtext_type: 0,
                    line_count: 1,
                    column_type: 0,
                    column_count: 0,
                    column_flags: 0,
                    column_width: 0.0,
                    column_gutter: 0.0,
                    column_heights: &[],
                });
            }
            EntityType::MText(text) => {
                let mut flags = 0_u16;
                if text.rectangle_height.is_some() {
                    flags |= TEXT_FLAG_HAS_RECTANGLE_HEIGHT;
                }
                if text.is_annotative {
                    flags |= TEXT_FLAG_ANNOTATIVE;
                }
                let mut column_flags = 0_u32;
                if text.column_data.auto_height {
                    column_flags |= 1;
                }
                if text.column_data.flow_reversed {
                    column_flags |= 1 << 1;
                }
                rows.push(SourceTextRow {
                    common: &text.common,
                    kind: 1,
                    flags,
                    style_name: &text.style,
                    value: &text.value,
                    tag: "",
                    prompt: "",
                    linked_handle: 0,
                    insertion_point: text.insertion_point,
                    alignment_point: Vector3::ZERO,
                    normal: text.normal,
                    x_axis_direction: Vector3::new(text.rotation.cos(), text.rotation.sin(), 0.0),
                    height: text.height,
                    width_factor: 1.0,
                    rotation: text.rotation,
                    oblique_angle: 0.0,
                    thickness: 0.0,
                    rectangle_width: text.rectangle_width,
                    rectangle_height: text.rectangle_height.unwrap_or(0.0),
                    extents_width: 0.0,
                    extents_height: 0.0,
                    line_spacing_factor: text.line_spacing_factor,
                    background_scale: text.background_scale,
                    background_color: encode_color(text.background_color),
                    background_transparency: text.background_transparency,
                    background_flags: text.background_fill_flags,
                    source_flags: 0,
                    horizontal_alignment: 0,
                    vertical_alignment: 0,
                    attachment: text.attachment_point as i16,
                    flow_direction: text.drawing_direction as i16,
                    line_spacing_style: text.line_spacing_style as i16,
                    generation_flags: 0,
                    field_length: 0,
                    mtext_type: 0,
                    line_count: 0,
                    column_type: i32::from(text.column_data.column_type),
                    column_count: text.column_data.column_count,
                    column_flags,
                    column_width: text.column_data.width,
                    column_gutter: text.column_data.gutter,
                    column_heights: &text.column_data.heights,
                });
            }
            EntityType::AttributeDefinition(attribute) => {
                rows.push(source_attribute_definition_row(attribute));
            }
            EntityType::AttributeEntity(attribute) => {
                rows.push(source_attribute_row(attribute));
            }
            EntityType::Insert(insert) => {
                rows.extend(insert.attributes.iter().map(source_attribute_row));
            }
            _ => {}
        }
    }
    rows
}

fn source_attribute_definition_row(
    attribute: &acadrust::entities::AttributeDefinition,
) -> SourceTextRow<'_> {
    let mut flags = TEXT_FLAG_HAS_ALIGNMENT_POINT;
    if attribute.flags.annotative {
        flags |= TEXT_FLAG_ANNOTATIVE;
    }
    if attribute.is_multiline {
        flags |= TEXT_FLAG_MULTILINE;
    }
    if attribute.lock_position {
        flags |= TEXT_FLAG_LOCK_POSITION;
    }
    SourceTextRow {
        common: &attribute.common,
        kind: 2,
        flags,
        style_name: &attribute.text_style,
        value: &attribute.default_value,
        tag: &attribute.tag,
        prompt: &attribute.prompt,
        linked_handle: 0,
        insertion_point: attribute.insertion_point,
        alignment_point: attribute.alignment_point,
        normal: attribute.normal,
        x_axis_direction: Vector3::new(attribute.rotation.cos(), attribute.rotation.sin(), 0.0),
        height: attribute.height,
        width_factor: attribute.width_factor,
        rotation: attribute.rotation,
        oblique_angle: attribute.oblique_angle,
        thickness: 0.0,
        rectangle_width: 0.0,
        rectangle_height: 0.0,
        extents_width: 0.0,
        extents_height: 0.0,
        line_spacing_factor: 0.0,
        background_scale: 0.0,
        background_color: 0,
        background_transparency: 0,
        background_flags: 0,
        source_flags: attribute.flags.to_bits(),
        horizontal_alignment: attribute.horizontal_alignment as i16,
        vertical_alignment: attribute.vertical_alignment as i16,
        attachment: 0,
        flow_direction: 0,
        line_spacing_style: 0,
        generation_flags: attribute.text_generation_flags,
        field_length: attribute.field_length,
        mtext_type: attribute.mtext_flag as i16,
        line_count: i32::from(attribute.line_count),
        column_type: 0,
        column_count: 0,
        column_flags: 0,
        column_width: 0.0,
        column_gutter: 0.0,
        column_heights: &[],
    }
}

fn source_attribute_row(attribute: &AttributeEntity) -> SourceTextRow<'_> {
    let mut flags = TEXT_FLAG_HAS_ALIGNMENT_POINT;
    if attribute.flags.annotative {
        flags |= TEXT_FLAG_ANNOTATIVE;
    }
    if attribute.is_multiline {
        flags |= TEXT_FLAG_MULTILINE;
    }
    if attribute.lock_position {
        flags |= TEXT_FLAG_LOCK_POSITION;
    }
    SourceTextRow {
        common: &attribute.common,
        kind: 3,
        flags,
        style_name: &attribute.text_style,
        value: &attribute.value,
        tag: &attribute.tag,
        prompt: "",
        linked_handle: attribute.attdef_handle.value(),
        insertion_point: attribute.insertion_point,
        alignment_point: attribute.alignment_point,
        normal: attribute.normal,
        x_axis_direction: Vector3::new(attribute.rotation.cos(), attribute.rotation.sin(), 0.0),
        height: attribute.height,
        width_factor: attribute.width_factor,
        rotation: attribute.rotation,
        oblique_angle: attribute.oblique_angle,
        thickness: 0.0,
        rectangle_width: 0.0,
        rectangle_height: 0.0,
        extents_width: 0.0,
        extents_height: 0.0,
        line_spacing_factor: 0.0,
        background_scale: 0.0,
        background_color: 0,
        background_transparency: 0,
        background_flags: 0,
        source_flags: attribute.flags.to_bits(),
        horizontal_alignment: attribute.horizontal_alignment as i16,
        vertical_alignment: attribute.vertical_alignment as i16,
        attachment: 0,
        flow_direction: 0,
        line_spacing_style: 0,
        generation_flags: attribute.text_generation_flags,
        field_length: attribute.field_length,
        mtext_type: attribute.mtext_flag as i16,
        line_count: i32::from(attribute.line_count),
        column_type: 0,
        column_count: 0,
        column_flags: 0,
        column_width: 0.0,
        column_gutter: 0.0,
        column_heights: &[],
    }
}

fn build_hatch_source_plan(document: &CadDocument) -> Result<HatchSourcePlan<'_>> {
    let mut plan = HatchSourcePlan {
        entities: Vec::new(),
        loops: Vec::new(),
        vertices: Vec::new(),
        gradient_colors: Vec::new(),
        seed_points: Vec::new(),
        pattern_lines: Vec::new(),
        pattern_dashes: Vec::new(),
        summary: HatchFillSummary::default(),
    };

    for entity in document.entities() {
        let EntityType::Hatch(hatch) = entity else {
            continue;
        };
        let hatch_index = u64::try_from(plan.entities.len()).context("too many HATCH entities")?;
        let first_loop = u64::try_from(plan.loops.len())?;
        let first_gradient_color = u64::try_from(plan.gradient_colors.len())?;
        let first_seed_point = u64::try_from(plan.seed_points.len())?;
        let mut hatch_vertex_count = 0_usize;
        let mut hatch_pattern_line_count = 0_usize;
        let mut hatch_pattern_dash_count = 0_usize;
        let mut fill_truncated = false;
        let mut pattern_truncated = false;

        plan.summary.source_hatches = plan
            .summary
            .source_hatches
            .checked_add(1)
            .context("HATCH source count overflow")?;
        if hatch.gradient_color.enabled {
            plan.summary.gradient_hatches = plan
                .summary
                .gradient_hatches
                .checked_add(1)
                .context("gradient HATCH count overflow")?;
        } else if hatch.is_solid {
            plan.summary.solid_hatches = plan
                .summary
                .solid_hatches
                .checked_add(1)
                .context("solid HATCH count overflow")?;
        } else {
            plan.summary.pattern_hatches = plan
                .summary
                .pattern_hatches
                .checked_add(1)
                .context("pattern HATCH count overflow")?;
        }

        for (path_index, path) in hatch.paths.iter().enumerate() {
            if path.flags.is_not_closed() {
                plan.summary.skipped_open_paths = plan
                    .summary
                    .skipped_open_paths
                    .checked_add(1)
                    .context("open HATCH path count overflow")?;
                continue;
            }
            let hatch_remaining = MAX_HATCH_BOUNDARY_SEGMENTS.saturating_sub(hatch_vertex_count);
            let global_remaining = MAX_HATCH_FILL_VERTICES.saturating_sub(plan.vertices.len());
            let maximum_vertices = hatch_remaining.min(global_remaining);
            match build_hatch_ring(hatch, path, maximum_vertices) {
                HatchRingBuild::Valid {
                    vertices,
                    approximated_curve,
                    signed_area,
                } => {
                    let first_vertex = u64::try_from(plan.vertices.len())?;
                    let vertex_count = u64::try_from(vertices.len())?;
                    hatch_vertex_count = hatch_vertex_count
                        .checked_add(vertices.len())
                        .context("HATCH vertex count overflow")?;
                    plan.vertices.extend(vertices);
                    plan.loops.push(HatchLoopRow {
                        hatch_index,
                        path_flags: path.flags.bits(),
                        source_path_index: u32::try_from(path_index)
                            .context("too many paths in HATCH entity")?,
                        first_vertex,
                        vertex_count,
                        source_edge_count: u32::try_from(path.edges.len())
                            .context("too many edges in HATCH path")?,
                        flags: if approximated_curve {
                            HATCH_LOOP_FLAG_APPROXIMATED_CURVE
                        } else {
                            0
                        },
                        signed_area,
                    });
                }
                HatchRingBuild::Open => {
                    plan.summary.skipped_open_paths = plan
                        .summary
                        .skipped_open_paths
                        .checked_add(1)
                        .context("open HATCH path count overflow")?;
                }
                HatchRingBuild::Invalid => {
                    plan.summary.skipped_invalid_paths = plan
                        .summary
                        .skipped_invalid_paths
                        .checked_add(1)
                        .context("invalid HATCH path count overflow")?;
                }
                HatchRingBuild::Truncated => {
                    fill_truncated = true;
                    break;
                }
            }
        }

        for color in &hatch.gradient_color.colors {
            if plan.gradient_colors.len() >= MAX_HATCH_AUX_RECORDS || !color.value.is_finite() {
                fill_truncated = true;
                continue;
            }
            plan.gradient_colors.push(HatchGradientColorRow {
                value: color.value,
                color: encode_color(color.color),
            });
        }
        for seed in &hatch.seed_points {
            if plan.seed_points.len() >= MAX_HATCH_AUX_RECORDS
                || !seed.x.is_finite()
                || !seed.y.is_finite()
            {
                fill_truncated = true;
                continue;
            }
            plan.seed_points.push([seed.x, seed.y]);
        }
        for (source_line_index, line) in hatch.pattern.lines.iter().enumerate() {
            if !hatch_pattern_line_is_finite(line) {
                plan.summary.skipped_invalid_pattern_lines = plan
                    .summary
                    .skipped_invalid_pattern_lines
                    .checked_add(1)
                    .context("invalid HATCH pattern line count overflow")?;
                continue;
            }
            let dash_count = line.dash_lengths.len();
            if hatch_pattern_line_count >= MAX_HATCH_PATTERN_LINES_PER_ENTITY
                || hatch_pattern_dash_count
                    .checked_add(dash_count)
                    .is_none_or(|count| count > MAX_HATCH_PATTERN_DASHES_PER_ENTITY)
                || plan.pattern_lines.len() >= MAX_HATCH_PATTERN_LINES
                || plan
                    .pattern_dashes
                    .len()
                    .checked_add(dash_count)
                    .is_none_or(|count| count > MAX_HATCH_PATTERN_DASHES)
            {
                pattern_truncated = true;
                break;
            }
            let first_dash = u64::try_from(plan.pattern_dashes.len())?;
            plan.pattern_dashes
                .extend(line.dash_lengths.iter().copied());
            plan.pattern_lines.push(HatchPatternLineRow {
                hatch_index,
                source_line_index: u32::try_from(source_line_index)
                    .context("too many pattern lines in HATCH entity")?,
                angle: line.angle,
                base_point: [line.base_point.x, line.base_point.y],
                offset: [line.offset.x, line.offset.y],
                first_dash,
                dash_count: u32::try_from(dash_count)
                    .context("too many dashes in HATCH pattern line")?,
            });
            hatch_pattern_line_count += 1;
            hatch_pattern_dash_count += dash_count;
        }

        let loop_count = u64::try_from(plan.loops.len())?
            .checked_sub(first_loop)
            .context("HATCH loop range underflow")?;
        let gradient_color_count = u64::try_from(plan.gradient_colors.len())?
            .checked_sub(first_gradient_color)
            .context("HATCH gradient-color range underflow")?;
        let seed_point_count = u64::try_from(plan.seed_points.len())?
            .checked_sub(first_seed_point)
            .context("HATCH seed-point range underflow")?;
        if fill_truncated {
            plan.summary.truncated_fill_hatches = plan
                .summary
                .truncated_fill_hatches
                .checked_add(1)
                .context("truncated HATCH count overflow")?;
        }
        if pattern_truncated {
            plan.summary.truncated_pattern_hatches = plan
                .summary
                .truncated_pattern_hatches
                .checked_add(1)
                .context("truncated pattern HATCH count overflow")?;
        }
        plan.entities.push(HatchEntityRow {
            hatch,
            first_loop,
            loop_count,
            first_gradient_color,
            gradient_color_count,
            first_seed_point,
            seed_point_count,
            definition_line_count: u32::try_from(hatch.pattern.lines.len())
                .context("too many HATCH pattern definition lines")?,
            truncated: fill_truncated || pattern_truncated,
        });
    }

    plan.summary.fill_loops = u64::try_from(plan.loops.len())?;
    plan.summary.fill_vertices = u64::try_from(plan.vertices.len())?;
    plan.summary.gradient_colors = u64::try_from(plan.gradient_colors.len())?;
    plan.summary.seed_points = u64::try_from(plan.seed_points.len())?;
    plan.summary.pattern_definition_lines = u64::try_from(plan.pattern_lines.len())?;
    plan.summary.pattern_dashes = u64::try_from(plan.pattern_dashes.len())?;
    Ok(plan)
}

fn hatch_pattern_line_is_finite(line: &HatchPatternLine) -> bool {
    line.angle.is_finite()
        && line.base_point.x.is_finite()
        && line.base_point.y.is_finite()
        && line.offset.x.is_finite()
        && line.offset.y.is_finite()
        && line.dash_lengths.iter().all(|dash| dash.is_finite())
}

fn build_hatch_ring(
    hatch: &Hatch,
    path: &acadrust::entities::BoundaryPath,
    maximum_vertices: usize,
) -> HatchRingBuild {
    let mut requested_segments = 0_usize;
    for edge in &path.edges {
        let count = hatch_edge_segment_count(edge);
        if count == 0 {
            return HatchRingBuild::Invalid;
        }
        requested_segments = requested_segments.saturating_add(count);
        if requested_segments > maximum_vertices {
            return HatchRingBuild::Truncated;
        }
    }
    if requested_segments < 3 {
        return HatchRingBuild::Invalid;
    }

    let mut vertices = Vec::with_capacity(requested_segments.saturating_add(1));
    let mut approximated_curve = false;
    for edge in &path.edges {
        let segment_count = hatch_edge_segment_count(edge);
        let Some(first) = hatch_edge_segment(hatch, edge, 0) else {
            return HatchRingBuild::Invalid;
        };
        let Some(last) = hatch_edge_segment(hatch, edge, segment_count - 1) else {
            return HatchRingBuild::Invalid;
        };
        approximated_curve |= match edge {
            BoundaryEdge::Line(_) => false,
            BoundaryEdge::Polyline(polyline) => polyline
                .vertices
                .iter()
                .any(|vertex| vertex.z.abs() > CURVE_EPSILON),
            _ => true,
        };

        let reverse = if let Some(current) = vertices.last().copied() {
            if hatch_points_near(current, first.start) {
                false
            } else if hatch_points_near(current, last.end) {
                true
            } else {
                return HatchRingBuild::Open;
            }
        } else {
            vertices.push(first.start);
            false
        };

        if reverse {
            for segment_index in (0..segment_count).rev() {
                let Some(segment) = hatch_edge_segment(hatch, edge, segment_index) else {
                    return HatchRingBuild::Invalid;
                };
                let Some(current) = vertices.last().copied() else {
                    return HatchRingBuild::Invalid;
                };
                if !hatch_points_near(current, segment.end) {
                    return HatchRingBuild::Open;
                }
                if !hatch_points_near(current, segment.start) {
                    vertices.push(segment.start);
                }
            }
        } else {
            for segment_index in 0..segment_count {
                let Some(segment) = hatch_edge_segment(hatch, edge, segment_index) else {
                    return HatchRingBuild::Invalid;
                };
                let Some(current) = vertices.last().copied() else {
                    return HatchRingBuild::Invalid;
                };
                if !hatch_points_near(current, segment.start) {
                    return HatchRingBuild::Open;
                }
                if !hatch_points_near(current, segment.end) {
                    vertices.push(segment.end);
                }
            }
        }
    }

    if vertices.iter().any(|point| !vector_is_finite(*point)) {
        return HatchRingBuild::Invalid;
    }
    let Some(last) = vertices.last().copied() else {
        return HatchRingBuild::Invalid;
    };
    if !hatch_points_near(vertices[0], last) {
        return HatchRingBuild::Open;
    }
    vertices.pop();
    if vertices.len() < 3 {
        return HatchRingBuild::Invalid;
    }
    let (signed_area, extent) = hatch_projected_area(&vertices, hatch.normal);
    let area_tolerance = (extent * extent * 1.0e-14).max(1.0e-18);
    if !signed_area.is_finite() || signed_area.abs() <= area_tolerance {
        return HatchRingBuild::Invalid;
    }
    HatchRingBuild::Valid {
        vertices,
        approximated_curve,
        signed_area,
    }
}

fn hatch_points_near(left: Vector3, right: Vector3) -> bool {
    if !vector_is_finite(left) || !vector_is_finite(right) {
        return false;
    }
    let scale = [
        left.x.abs(),
        left.y.abs(),
        left.z.abs(),
        right.x.abs(),
        right.y.abs(),
        right.z.abs(),
        1.0,
    ]
    .into_iter()
    .fold(1.0_f64, f64::max);
    let tolerance = 1.0e-8_f64.max(scale * f64::EPSILON * 64.0);
    (left.x - right.x).abs() <= tolerance
        && (left.y - right.y).abs() <= tolerance
        && (left.z - right.z).abs() <= tolerance
}

fn hatch_projected_area(vertices: &[Vector3], normal: Vector3) -> (f64, f64) {
    let safe_normal = finite_hatch_normal(normal);
    let dropped_axis = if safe_normal[0].abs() >= safe_normal[1].abs()
        && safe_normal[0].abs() >= safe_normal[2].abs()
    {
        0
    } else if safe_normal[1].abs() >= safe_normal[2].abs() {
        1
    } else {
        2
    };
    let project = |point: Vector3| match dropped_axis {
        0 => (point.y, point.z),
        1 => (point.x, point.z),
        _ => (point.x, point.y),
    };
    let (origin_x, origin_y) = project(vertices[0]);
    let mut twice_area = 0.0;
    let mut extent = 0.0_f64;
    for index in 0..vertices.len() {
        let (left_x, left_y) = project(vertices[index]);
        let (right_x, right_y) = project(vertices[(index + 1) % vertices.len()]);
        let left_x = left_x - origin_x;
        let left_y = left_y - origin_y;
        let right_x = right_x - origin_x;
        let right_y = right_y - origin_y;
        extent = extent
            .max(left_x.abs())
            .max(left_y.abs())
            .max(right_x.abs())
            .max(right_y.abs());
        twice_area += left_x * right_y - right_x * left_y;
    }
    (twice_area * 0.5, extent)
}

fn finite_hatch_normal(normal: Vector3) -> [f64; 3] {
    if vector_is_finite(normal) && normal.length_squared() > CURVE_EPSILON {
        [normal.x, normal.y, normal.z]
    } else {
        [0.0, 0.0, 1.0]
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn write_hatch_entity_section<W: Write + Seek>(
    writer: &mut W,
    plan: &HatchSourcePlan<'_>,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut strings = Vec::new();
    let mut string_references = Vec::with_capacity(plan.entities.len());
    for row in &plan.entities {
        string_references.push([
            push_string(&mut strings, &row.hatch.pattern.name)?,
            push_string(&mut strings, &row.hatch.gradient_color.name)?,
        ]);
    }
    let string_offset = STRING_TABLE_HEADER_SIZE
        + u64::try_from(plan.entities.len())? * u64::from(HATCH_ENTITY_RECORD_SIZE);
    write_u32(writer, u32::try_from(plan.entities.len())?)?;
    write_u32(writer, HATCH_ENTITY_RECORD_SIZE)?;
    write_u64(writer, string_offset)?;

    for (row, references) in plan.entities.iter().zip(string_references) {
        let hatch = row.hatch;
        let mut flags = 0_u32;
        if hatch.is_solid {
            flags |= HATCH_FLAG_SOLID;
        }
        if hatch.is_associative {
            flags |= HATCH_FLAG_ASSOCIATIVE;
        }
        if hatch.is_double {
            flags |= HATCH_FLAG_DOUBLE;
        }
        if hatch.gradient_color.enabled {
            flags |= HATCH_FLAG_GRADIENT;
        }
        if hatch.gradient_color.is_single_color {
            flags |= HATCH_FLAG_SINGLE_COLOR_GRADIENT;
        }
        if row.truncated {
            flags |= HATCH_FLAG_TRUNCATED;
        }

        write_common_data(writer, &hatch.common, layer_indices)?;
        for reference in references {
            write_u32(writer, reference.0)?;
            write_u32(writer, reference.1)?;
        }
        write_u32(writer, flags)?;
        write_u16(writer, hatch.style as u16)?;
        write_u16(writer, hatch.pattern_type as u16)?;
        write_u64(writer, row.first_loop)?;
        write_u64(writer, row.loop_count)?;
        write_u64(writer, row.first_gradient_color)?;
        write_u64(writer, row.gradient_color_count)?;
        write_f64(writer, finite_or(hatch.elevation, 0.0))?;
        for coordinate in finite_hatch_normal(hatch.normal) {
            write_f64(writer, coordinate)?;
        }
        write_f64(writer, finite_or(hatch.pattern_angle, 0.0))?;
        write_f64(writer, finite_or(hatch.pattern_scale, 1.0))?;
        write_f64(writer, finite_or(hatch.pixel_size, 0.0))?;
        write_f64(writer, finite_or(hatch.gradient_color.angle, 0.0))?;
        write_f64(writer, finite_or(hatch.gradient_color.shift, 0.0))?;
        write_f64(writer, finite_or(hatch.gradient_color.color_tint, 0.0))?;
        write_u64(writer, row.first_seed_point)?;
        write_u64(writer, row.seed_point_count)?;
        write_i32(writer, hatch.gradient_color.reserved)?;
        write_u32(writer, row.definition_line_count)?;
    }
    writer.write_all(&strings)?;
    finish_variable_section(
        writer,
        SectionKind::HatchEntities,
        HATCH_ENTITY_RECORD_SIZE,
        offset,
        u64::try_from(plan.entities.len())?,
        SECTION_FLAG_STRING_TABLE,
    )
}

fn write_hatch_loop_section<W: Write + Seek>(
    writer: &mut W,
    plan: &HatchSourcePlan<'_>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    for row in &plan.loops {
        write_u64(writer, row.hatch_index)?;
        write_u32(writer, row.path_flags)?;
        write_u32(writer, row.source_path_index)?;
        write_u64(writer, row.first_vertex)?;
        write_u64(writer, row.vertex_count)?;
        write_u32(writer, row.source_edge_count)?;
        write_u32(writer, row.flags)?;
        write_f64(writer, row.signed_area)?;
    }
    finish_fixed_section(
        writer,
        SectionKind::HatchLoops,
        HATCH_LOOP_RECORD_SIZE,
        offset,
        u64::try_from(plan.loops.len())?,
    )
}

fn write_hatch_vertex_section<W: Write + Seek>(
    writer: &mut W,
    plan: &HatchSourcePlan<'_>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    for vertex in &plan.vertices {
        write_vec3(writer, *vertex)?;
    }
    finish_fixed_section(
        writer,
        SectionKind::HatchVertices,
        HATCH_VERTEX_RECORD_SIZE,
        offset,
        u64::try_from(plan.vertices.len())?,
    )
}

fn write_hatch_gradient_color_section<W: Write + Seek>(
    writer: &mut W,
    plan: &HatchSourcePlan<'_>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    for color in &plan.gradient_colors {
        write_f64(writer, color.value)?;
        write_u32(writer, color.color)?;
        write_u32(writer, 0)?;
    }
    finish_fixed_section(
        writer,
        SectionKind::HatchGradientColors,
        HATCH_GRADIENT_COLOR_RECORD_SIZE,
        offset,
        u64::try_from(plan.gradient_colors.len())?,
    )
}

fn write_hatch_seed_point_section<W: Write + Seek>(
    writer: &mut W,
    plan: &HatchSourcePlan<'_>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    for seed in &plan.seed_points {
        write_f64(writer, seed[0])?;
        write_f64(writer, seed[1])?;
    }
    finish_fixed_section(
        writer,
        SectionKind::HatchSeedPoints,
        HATCH_SEED_POINT_RECORD_SIZE,
        offset,
        u64::try_from(plan.seed_points.len())?,
    )
}

fn write_hatch_pattern_line_section<W: Write + Seek>(
    writer: &mut W,
    plan: &HatchSourcePlan<'_>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    for line in &plan.pattern_lines {
        write_u64(writer, line.hatch_index)?;
        write_u32(writer, line.source_line_index)?;
        write_u32(writer, 0)?;
        write_f64(writer, line.angle)?;
        write_f64(writer, line.base_point[0])?;
        write_f64(writer, line.base_point[1])?;
        write_f64(writer, line.offset[0])?;
        write_f64(writer, line.offset[1])?;
        write_u64(writer, line.first_dash)?;
        write_u32(writer, line.dash_count)?;
        write_u32(writer, 0)?;
    }
    finish_fixed_section(
        writer,
        SectionKind::HatchPatternLines,
        HATCH_PATTERN_LINE_RECORD_SIZE,
        offset,
        u64::try_from(plan.pattern_lines.len())?,
    )
}

fn write_hatch_pattern_dash_section<W: Write + Seek>(
    writer: &mut W,
    plan: &HatchSourcePlan<'_>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    for dash in &plan.pattern_dashes {
        write_f64(writer, *dash)?;
    }
    finish_fixed_section(
        writer,
        SectionKind::HatchPatternDashes,
        HATCH_PATTERN_DASH_RECORD_SIZE,
        offset,
        u64::try_from(plan.pattern_dashes.len())?,
    )
}

fn write_point_entity_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        let EntityType::Point(point) = entity else {
            continue;
        };
        write_common(writer, entity, layer_indices)?;
        write_vec3(writer, point.location)?;
        write_vec3(writer, point.normal)?;
        write_f64(writer, point.thickness)?;
        write_f64(writer, point.x_axis_angle)?;
        write_f64(writer, document.header.point_display_size)?;
        write_i16(writer, document.header.point_display_mode)?;
        write_u16(writer, 0)?;
        write_u32(writer, 0)?;
        count += 1;
    }
    finish_fixed_section(
        writer,
        SectionKind::PointEntities,
        POINT_ENTITY_RECORD_SIZE,
        offset,
        count,
    )
}

fn write_solid_entity_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        let EntityType::Solid(solid) = entity else {
            continue;
        };
        write_common(writer, entity, layer_indices)?;
        write_u32(writer, u32::from(document.header.fill_mode))?;
        write_u32(writer, 0)?;
        for corner in [
            solid.first_corner,
            solid.second_corner,
            solid.third_corner,
            solid.fourth_corner,
        ] {
            write_vec3(writer, corner)?;
        }
        write_vec3(writer, solid.normal)?;
        write_f64(writer, solid.thickness)?;
        count += 1;
    }
    finish_fixed_section(
        writer,
        SectionKind::SolidEntities,
        SOLID_ENTITY_RECORD_SIZE,
        offset,
        count,
    )
}

fn write_face_entity_section<W: Write + Seek>(
    writer: &mut W,
    document: &CadDocument,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        let EntityType::Face3D(face) = entity else {
            continue;
        };
        let invisible_edges = u32::from(face.invisible_edges.bits());
        if invisible_edges & !0xf != 0 {
            anyhow::bail!("3DFACE source contains unsupported invisible-edge flags");
        }
        let corners = [
            face.first_corner,
            face.second_corner,
            face.third_corner,
            face.fourth_corner,
        ];
        if corners.iter().any(|corner| !vector_is_finite(*corner)) {
            anyhow::bail!("3DFACE source contains a non-finite corner");
        }
        write_common(writer, entity, layer_indices)?;
        write_u32(writer, invisible_edges)?;
        write_u32(writer, 0)?;
        for corner in corners {
            write_vec3(writer, corner)?;
        }
        count += 1;
    }
    finish_fixed_section(
        writer,
        SectionKind::FaceEntities,
        FACE_ENTITY_RECORD_SIZE,
        offset,
        count,
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
    block_targets: &HashMap<String, BlockInstanceTarget>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut count = 0_u64;
    for entity in document.entities() {
        match entity {
            EntityType::Insert(insert) => {
                let block_index = block_targets
                    .get(&insert.block_name.to_uppercase())
                    .map(|target| target.index)
                    .unwrap_or(u32::MAX);
                write_block_instance_record(
                    writer,
                    entity,
                    layer_indices,
                    block_index,
                    insert.column_count,
                    insert.row_count,
                    insert.insert_point,
                    Vector3::new(insert.x_scale(), insert.y_scale(), insert.z_scale()),
                    insert.rotation,
                    insert.normal,
                    insert.column_spacing,
                    insert.row_spacing,
                )?;
                count += 1;
            }
            EntityType::Dimension(dimension) => {
                let Some(target) = dimension_instance_target(dimension, block_targets) else {
                    continue;
                };
                write_block_instance_record(
                    writer,
                    entity,
                    layer_indices,
                    target.index,
                    1,
                    1,
                    target.base_point,
                    Vector3::new(1.0, 1.0, 1.0),
                    0.0,
                    Vector3::UNIT_Z,
                    0.0,
                    0.0,
                )?;
                count += 1;
            }
            _ => {}
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

#[allow(clippy::too_many_arguments)]
fn write_block_instance_record<W: Write>(
    writer: &mut W,
    entity: &EntityType,
    layer_indices: &HashMap<String, u32>,
    block_index: u32,
    columns: u16,
    rows: u16,
    insert_point: Vector3,
    scale: Vector3,
    rotation: f64,
    normal: Vector3,
    column_spacing: f64,
    row_spacing: f64,
) -> Result<()> {
    write_common(writer, entity, layer_indices)?;
    write_u32(writer, block_index)?;
    write_u16(writer, columns)?;
    write_u16(writer, rows)?;
    write_vec3(writer, insert_point)?;
    write_vec3(writer, scale)?;
    write_f64(writer, rotation)?;
    write_vec3(writer, normal)?;
    write_f64(writer, column_spacing)?;
    write_f64(writer, row_spacing)?;
    Ok(())
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
enum GpuLineBatchKind {
    ModelOverview = 0,
    ModelDetail = 1,
    BlockDefinition = 2,
}

#[derive(Debug, Clone, Copy)]
enum GpuEntityGroupKind {
    Model,
    Block(u32),
}

#[derive(Debug)]
struct GpuEntityGroup {
    kind: GpuEntityGroupKind,
    entity_indices: Vec<u32>,
}

#[derive(Debug)]
struct PreparedGpuEntityGroup {
    kind: GpuEntityGroupKind,
    segments: Vec<SpatialSegmentRef>,
}

#[derive(Debug, Clone, Copy)]
struct SpatialSegmentRef {
    morton: u32,
    entity_index: u32,
    segment_index: u32,
}

#[derive(Debug)]
struct GpuLineBatchPlan {
    kind: GpuLineBatchKind,
    lod_level: u16,
    flags: u32,
    block_index: u32,
    first_vertex: u64,
    vertex_count: u64,
    segment_start: usize,
    segment_count: u32,
    origin: Vector3,
    bounds: FiniteBounds3,
    maximum_position_error: f32,
}

#[derive(Debug)]
struct GpuLinePlan<'a> {
    entities: Vec<&'a EntityType>,
    segments: Vec<SpatialSegmentRef>,
    batches: Vec<GpuLineBatchPlan>,
    summary: GpuLineSummary,
}

#[derive(Debug, Clone, Copy)]
struct GpuSegmentGeometry {
    start: Vector3,
    end: Vector3,
    approximated_curve: bool,
}

#[derive(Debug, Clone, Copy)]
struct FiniteBounds3 {
    min: Vector3,
    max: Vector3,
}

impl FiniteBounds3 {
    fn empty() -> Self {
        Self {
            min: Vector3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY),
            max: Vector3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY),
        }
    }

    fn include(&mut self, point: Vector3) {
        self.min.x = self.min.x.min(point.x);
        self.min.y = self.min.y.min(point.y);
        self.min.z = self.min.z.min(point.z);
        self.max.x = self.max.x.max(point.x);
        self.max.y = self.max.y.max(point.y);
        self.max.z = self.max.z.max(point.z);
    }

    fn center(self) -> Vector3 {
        Vector3::new(
            self.min.x * 0.5 + self.max.x * 0.5,
            self.min.y * 0.5 + self.max.y * 0.5,
            self.min.z * 0.5 + self.max.z * 0.5,
        )
    }
}

#[derive(Debug, Clone, Copy)]
struct FiniteBounds2 {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl FiniteBounds2 {
    fn empty() -> Self {
        Self {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        }
    }

    fn include(&mut self, x: f64, y: f64) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }
}

fn build_gpu_line_plan(document: &CadDocument) -> Result<GpuLinePlan<'_>> {
    let mut groups = vec![GpuEntityGroup {
        kind: GpuEntityGroupKind::Model,
        entity_indices: Vec::new(),
    }];
    let mut owner_groups = HashMap::new();

    for (block_index, block) in document.block_records.iter().enumerate() {
        if block.is_model_space() {
            if !block.handle.is_null() {
                owner_groups.insert(block.handle.value(), 0);
            }
        } else if !block.is_paper_space() {
            let group_index = groups.len();
            groups.push(GpuEntityGroup {
                kind: GpuEntityGroupKind::Block(
                    u32::try_from(block_index).context("too many blocks for GPU line cache")?,
                ),
                entity_indices: Vec::new(),
            });
            if !block.handle.is_null() {
                owner_groups.insert(block.handle.value(), group_index);
            }
        }
    }
    if !document.header.model_space_block_handle.is_null() {
        owner_groups.insert(document.header.model_space_block_handle.value(), 0);
    }

    let mut entities = Vec::new();
    for entity in document.entities() {
        if gpu_entity_segment_count(entity) == 0 {
            continue;
        }
        let common = entity.common();
        let group_index = owner_groups
            .get(&common.owner_handle.value())
            .copied()
            .or_else(|| {
                (common.entity_mode == Some(2) || common.owner_handle.is_null()).then_some(0)
            });
        let Some(group_index) = group_index else {
            continue;
        };
        let entity_index =
            u32::try_from(entities.len()).context("too many GPU line source entities")?;
        entities.push(entity);
        groups[group_index].entity_indices.push(entity_index);
    }

    let mut draw_segments = Vec::new();
    let mut batches = Vec::new();
    let mut summary = GpuLineSummary::default();
    let mut prepared_groups = Vec::with_capacity(groups.len());

    for group in groups {
        let (segments, approximated, hatch_boundaries, truncated_hatches, skipped) =
            build_spatial_segment_refs(&entities, &group.entity_indices)?;
        summary.approximated_curve_segments = summary
            .approximated_curve_segments
            .checked_add(approximated)
            .context("approximated GPU segment count overflow")?;
        summary.hatch_boundary_segments = summary
            .hatch_boundary_segments
            .checked_add(hatch_boundaries)
            .context("HATCH boundary segment count overflow")?;
        summary.truncated_hatch_entities = summary
            .truncated_hatch_entities
            .checked_add(truncated_hatches)
            .context("truncated HATCH entity count overflow")?;
        summary.skipped_non_finite_segments = summary
            .skipped_non_finite_segments
            .checked_add(skipped)
            .context("skipped GPU segment count overflow")?;

        match group.kind {
            GpuEntityGroupKind::Model => {
                summary.model_segments =
                    u64::try_from(segments.len()).context("too many model GPU line segments")?;
            }
            GpuEntityGroupKind::Block(_) => {
                summary.block_segments = summary
                    .block_segments
                    .checked_add(u64::try_from(segments.len())?)
                    .context("block GPU line segment count overflow")?;
            }
        }
        prepared_groups.push(PreparedGpuEntityGroup {
            kind: group.kind,
            segments,
        });
    }

    let total_detail_segments = prepared_groups.iter().try_fold(0_usize, |total, group| {
        total
            .checked_add(group.segments.len())
            .context("GPU detail segment count overflow")
    })?;
    let has_separate_overview = total_detail_segments > SCENE_OVERVIEW_SEGMENTS;

    if has_separate_overview {
        let quotas = allocate_overview_quotas(&prepared_groups, SCENE_OVERVIEW_SEGMENTS);
        for (group, quota) in prepared_groups.iter().zip(quotas) {
            if quota == 0 {
                continue;
            }
            let mut overview = sample_spatial_segments(&group.segments, quota);
            summary.overview_segments = summary
                .overview_segments
                .checked_add(u64::try_from(overview.len())?)
                .context("GPU overview segment count overflow")?;
            let (kind, block_index) = match group.kind {
                GpuEntityGroupKind::Model => (GpuLineBatchKind::ModelOverview, u32::MAX),
                GpuEntityGroupKind::Block(block_index) => {
                    (GpuLineBatchKind::BlockDefinition, block_index)
                }
            };
            append_gpu_line_batches(
                &entities,
                &mut overview,
                kind,
                0,
                block_index,
                &mut draw_segments,
                &mut batches,
                &mut summary,
            )?;
        }
    } else {
        summary.overview_segments = u64::try_from(total_detail_segments)?;
    }

    for group in &mut prepared_groups {
        let (kind, block_index) = match group.kind {
            GpuEntityGroupKind::Model => (GpuLineBatchKind::ModelDetail, u32::MAX),
            GpuEntityGroupKind::Block(block_index) => {
                (GpuLineBatchKind::BlockDefinition, block_index)
            }
        };
        append_gpu_line_batches(
            &entities,
            &mut group.segments,
            kind,
            if has_separate_overview { 1 } else { 0 },
            block_index,
            &mut draw_segments,
            &mut batches,
            &mut summary,
        )?;
    }

    summary.batches = u64::try_from(batches.len())?;
    summary.vertices = batches.iter().try_fold(0_u64, |total, batch| {
        total
            .checked_add(batch.vertex_count)
            .context("GPU line vertex count overflow")
    })?;
    summary.cached_vertex_bytes = summary
        .vertices
        .checked_mul(u64::from(GPU_LINE_VERTEX_RECORD_SIZE))
        .context("GPU line vertex byte size overflow")?;
    summary.first_frame_vertex_bytes = summary
        .overview_segments
        .checked_mul(2)
        .and_then(|value| value.checked_mul(u64::from(GPU_LINE_VERTEX_RECORD_SIZE)))
        .context("scene overview byte size overflow")?;
    summary.full_detail_vertex_bytes = summary
        .model_segments
        .checked_add(summary.block_segments)
        .and_then(|value| value.checked_mul(2))
        .and_then(|value| value.checked_mul(u64::from(GPU_LINE_VERTEX_RECORD_SIZE)))
        .context("full-detail GPU line byte size overflow")?;

    Ok(GpuLinePlan {
        entities,
        segments: draw_segments,
        batches,
        summary,
    })
}

fn build_spatial_segment_refs(
    entities: &[&EntityType],
    entity_indices: &[u32],
) -> Result<(Vec<SpatialSegmentRef>, u64, u64, u64, u64)> {
    let mut midpoint_bounds = FiniteBounds2::empty();
    let mut valid_segments = 0_usize;
    let mut approximated_segments = 0_u64;
    let mut hatch_boundary_segments = 0_u64;
    let mut truncated_hatch_entities = 0_u64;
    let mut skipped_segments = 0_u64;

    for &entity_index in entity_indices {
        let entity = entities[entity_index as usize];
        if let EntityType::Hatch(hatch) = entity {
            if hatch_boundary_segment_limit(hatch).1 {
                truncated_hatch_entities = truncated_hatch_entities
                    .checked_add(1)
                    .context("truncated HATCH entity count overflow")?;
            }
        }
        for segment_index in 0..gpu_entity_segment_count(entity) {
            let geometry = gpu_segment_geometry(entity, segment_index);
            let Some(geometry) = geometry.filter(gpu_segment_is_finite) else {
                skipped_segments = skipped_segments
                    .checked_add(1)
                    .context("skipped GPU segment count overflow")?;
                continue;
            };
            let midpoint_x = geometry.start.x * 0.5 + geometry.end.x * 0.5;
            let midpoint_y = geometry.start.y * 0.5 + geometry.end.y * 0.5;
            midpoint_bounds.include(midpoint_x, midpoint_y);
            valid_segments = valid_segments
                .checked_add(1)
                .context("GPU segment count overflow")?;
            if geometry.approximated_curve {
                approximated_segments = approximated_segments
                    .checked_add(1)
                    .context("approximated GPU segment count overflow")?;
            }
            if matches!(entity, EntityType::Hatch(_)) {
                hatch_boundary_segments = hatch_boundary_segments
                    .checked_add(1)
                    .context("HATCH boundary segment count overflow")?;
            }
        }
    }

    let mut segments = Vec::with_capacity(valid_segments);
    for &entity_index in entity_indices {
        let entity = entities[entity_index as usize];
        for segment_index in 0..gpu_entity_segment_count(entity) {
            let Some(geometry) =
                gpu_segment_geometry(entity, segment_index).filter(gpu_segment_is_finite)
            else {
                continue;
            };
            let midpoint_x = geometry.start.x * 0.5 + geometry.end.x * 0.5;
            let midpoint_y = geometry.start.y * 0.5 + geometry.end.y * 0.5;
            segments.push(SpatialSegmentRef {
                morton: morton_key(midpoint_x, midpoint_y, midpoint_bounds),
                entity_index,
                segment_index: u32::try_from(segment_index)
                    .context("entity has too many GPU line segments")?,
            });
        }
    }
    segments.sort_unstable_by_key(|segment| {
        (segment.morton, segment.entity_index, segment.segment_index)
    });

    Ok((
        segments,
        approximated_segments,
        hatch_boundary_segments,
        truncated_hatch_entities,
        skipped_segments,
    ))
}

fn allocate_overview_quotas(groups: &[PreparedGpuEntityGroup], budget: usize) -> Vec<usize> {
    let lengths: Vec<_> = groups.iter().map(|group| group.segments.len()).collect();
    let total = lengths.iter().sum::<usize>();
    if total <= budget {
        return lengths;
    }

    let nonempty: Vec<_> = lengths
        .iter()
        .enumerate()
        .filter_map(|(index, &length)| (length > 0).then_some(index))
        .collect();
    let mut quotas = vec![0_usize; groups.len()];
    if nonempty.len() > budget {
        let mut by_size = nonempty;
        by_size.sort_unstable_by(|&left, &right| {
            lengths[right]
                .cmp(&lengths[left])
                .then_with(|| left.cmp(&right))
        });
        for index in by_size.into_iter().take(budget) {
            quotas[index] = 1;
        }
        return quotas;
    }

    for &index in &nonempty {
        quotas[index] = 1;
    }
    let remaining = budget - nonempty.len();
    let capacity_total = total - nonempty.len();
    if remaining == 0 || capacity_total == 0 {
        return quotas;
    }

    let mut allocated = 0_usize;
    let mut remainders = Vec::with_capacity(nonempty.len());
    for &index in &nonempty {
        let capacity = lengths[index] - 1;
        let numerator = (remaining as u128) * (capacity as u128);
        let extra = usize::try_from(numerator / (capacity_total as u128))
            .expect("overview quota cannot exceed usize");
        quotas[index] += extra;
        allocated += extra;
        remainders.push((numerator % (capacity_total as u128), index));
    }

    remainders
        .sort_unstable_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    for &(_, index) in remainders.iter().take(remaining - allocated) {
        if quotas[index] < lengths[index] {
            quotas[index] += 1;
        }
    }
    quotas
}

fn sample_spatial_segments(
    segments: &[SpatialSegmentRef],
    sample_count: usize,
) -> Vec<SpatialSegmentRef> {
    if sample_count >= segments.len() {
        return segments.to_vec();
    }
    if sample_count == 0 {
        return Vec::new();
    }
    if sample_count == 1 {
        return vec![segments[segments.len() / 2]];
    }

    let mut overview = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        overview.push(segments[index * (segments.len() - 1) / (sample_count - 1)]);
    }
    overview
}

#[allow(clippy::too_many_arguments)]
fn append_gpu_line_batches(
    entities: &[&EntityType],
    segments: &mut Vec<SpatialSegmentRef>,
    kind: GpuLineBatchKind,
    lod_level: u16,
    block_index: u32,
    draw_segments: &mut Vec<SpatialSegmentRef>,
    batches: &mut Vec<GpuLineBatchPlan>,
    summary: &mut GpuLineSummary,
) -> Result<()> {
    let destination_start = draw_segments.len();
    for chunk_start in (0..segments.len()).step_by(GPU_LINE_BATCH_SEGMENTS) {
        let chunk_end = (chunk_start + GPU_LINE_BATCH_SEGMENTS).min(segments.len());
        let chunk = &segments[chunk_start..chunk_end];
        let mut bounds = FiniteBounds3::empty();
        let mut flags = 0_u32;
        for segment in chunk {
            let geometry = resolve_gpu_segment(entities, *segment)?;
            bounds.include(geometry.start);
            bounds.include(geometry.end);
            if geometry.approximated_curve {
                flags |= GPU_BATCH_FLAG_APPROXIMATED_CURVE;
            }
        }
        let origin = bounds.center();
        let maximum_position_error = rebased_position_error_bound(bounds, origin)?;
        let encoded_maximum_position_error =
            round_up_f32(maximum_position_error).context("GPU position error exceeds f32")?;

        let segment_count = u32::try_from(chunk.len())?;
        let vertex_count = u64::from(segment_count)
            .checked_mul(2)
            .context("GPU batch vertex count overflow")?;
        let first_vertex = batches
            .last()
            .map(|batch| {
                batch
                    .first_vertex
                    .checked_add(batch.vertex_count)
                    .context("GPU line vertex count overflow")
            })
            .transpose()?
            .unwrap_or(0);
        let maximum_batch_bytes = vertex_count
            .checked_mul(u64::from(GPU_LINE_VERTEX_RECORD_SIZE))
            .context("GPU batch byte size overflow")?;
        summary.maximum_batch_bytes = summary.maximum_batch_bytes.max(maximum_batch_bytes);
        summary.maximum_position_error = summary.maximum_position_error.max(maximum_position_error);
        match kind {
            GpuLineBatchKind::ModelOverview => {
                summary.model_overview_batches += 1;
            }
            GpuLineBatchKind::ModelDetail => {
                summary.model_detail_batches += 1;
            }
            GpuLineBatchKind::BlockDefinition => {
                summary.block_batches += 1;
                if lod_level == 0 {
                    summary.block_overview_batches += 1;
                } else {
                    summary.block_detail_batches += 1;
                }
            }
        }

        batches.push(GpuLineBatchPlan {
            kind,
            lod_level,
            flags,
            block_index,
            first_vertex,
            vertex_count,
            segment_start: destination_start + chunk_start,
            segment_count,
            origin,
            bounds,
            maximum_position_error: encoded_maximum_position_error,
        });
    }
    draw_segments.append(segments);
    segments.shrink_to_fit();
    Ok(())
}

fn write_gpu_line_batch_section<W: Write + Seek>(
    writer: &mut W,
    plan: &GpuLinePlan<'_>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    for (batch_id, batch) in plan.batches.iter().enumerate() {
        write_u32(writer, u32::try_from(batch_id)?)?;
        write_u16(writer, batch.kind as u16)?;
        write_u16(writer, batch.lod_level)?;
        write_u32(writer, batch.flags)?;
        write_u32(writer, batch.block_index)?;
        write_u64(writer, batch.first_vertex)?;
        write_u64(writer, batch.vertex_count)?;
        write_u32(writer, batch.segment_count)?;
        write_u32(writer, 0)?;
        write_vec3(writer, batch.origin)?;
        write_vec3(writer, batch.bounds.min)?;
        write_vec3(writer, batch.bounds.max)?;
        write_f32(writer, batch.maximum_position_error)?;
        write_u32(writer, 0)?;
        write_u64(writer, 0)?;
    }
    finish_fixed_section(
        writer,
        SectionKind::GpuLineBatches,
        GPU_LINE_BATCH_RECORD_SIZE,
        offset,
        plan.batches.len() as u64,
    )
}

fn write_gpu_line_vertex_section<W: Write + Seek>(
    writer: &mut W,
    plan: &GpuLinePlan<'_>,
    layer_indices: &HashMap<String, u32>,
) -> Result<SectionEntry> {
    let offset = aligned_position(writer)?;
    let mut vertex_count = 0_u64;
    for batch in &plan.batches {
        let segment_start = batch.segment_start;
        let segment_end = segment_start
            .checked_add(batch.segment_count as usize)
            .context("GPU batch segment range overflow")?;
        for segment in &plan.segments[segment_start..segment_end] {
            let entity = plan.entities[segment.entity_index as usize];
            let geometry = resolve_gpu_segment(&plan.entities, *segment)?;
            let common = entity.common();
            let layer_index = layer_indices
                .get(&common.layer.to_uppercase())
                .copied()
                .unwrap_or(u32::MAX);
            let color = encode_color(common.color);
            let handle = common.handle.value();
            let style = encode_gpu_line_style(entity, geometry.approximated_curve);
            write_gpu_line_vertex(
                writer,
                geometry.start,
                batch.origin,
                layer_index,
                color,
                handle,
                style,
            )?;
            write_gpu_line_vertex(
                writer,
                geometry.end,
                batch.origin,
                layer_index,
                color,
                handle,
                style,
            )?;
            vertex_count = vertex_count
                .checked_add(2)
                .context("GPU line vertex count overflow")?;
        }
    }
    finish_fixed_section(
        writer,
        SectionKind::GpuLineVertices,
        GPU_LINE_VERTEX_RECORD_SIZE,
        offset,
        vertex_count,
    )
}

fn write_gpu_line_vertex<W: Write>(
    writer: &mut W,
    point: Vector3,
    origin: Vector3,
    layer_index: u32,
    color: u32,
    handle: u64,
    style: u32,
) -> Result<()> {
    write_f32(writer, rebased_coordinate(point.x, origin.x)?)?;
    write_f32(writer, rebased_coordinate(point.y, origin.y)?)?;
    write_f32(writer, rebased_coordinate(point.z, origin.z)?)?;
    write_u32(writer, layer_index)?;
    write_u32(writer, color)?;
    write_u32(writer, handle as u32)?;
    write_u32(writer, (handle >> 32) as u32)?;
    write_u32(writer, style)?;
    Ok(())
}

fn encode_gpu_line_style(entity: &EntityType, approximated_curve: bool) -> u32 {
    let common = entity.common();
    let mut style = u32::from(common.line_weight.value() as u16);
    if common.invisible {
        style |= GPU_STYLE_INVISIBLE;
    }
    style |= gpu_source_kind(entity) << GPU_STYLE_SOURCE_KIND_SHIFT;
    if approximated_curve {
        style |= GPU_STYLE_APPROXIMATED_CURVE;
    }
    style
}

fn gpu_source_kind(entity: &EntityType) -> u32 {
    match entity {
        EntityType::Line(_) => 0,
        EntityType::LwPolyline(_) => 1,
        EntityType::Polyline2D(_) => 2,
        EntityType::Polyline(_) => 3,
        EntityType::Arc(_) => 4,
        EntityType::Circle(_) => 5,
        EntityType::Ellipse(_) => 6,
        EntityType::Spline(_) => 7,
        EntityType::Hatch(_) => 8,
        _ => unreachable!("only GPU line and curve entities reach the vertex writer"),
    }
}

fn resolve_gpu_segment(
    entities: &[&EntityType],
    segment: SpatialSegmentRef,
) -> Result<GpuSegmentGeometry> {
    let entity = entities
        .get(segment.entity_index as usize)
        .context("GPU segment references an invalid entity")?;
    gpu_segment_geometry(entity, segment.segment_index as usize)
        .filter(gpu_segment_is_finite)
        .context("GPU segment geometry changed or became non-finite")
}

fn gpu_entity_segment_count(entity: &EntityType) -> usize {
    match entity {
        EntityType::Line(_) => 1,
        EntityType::LwPolyline(polyline) => {
            refined_polyline_segment_count(polyline.vertices.len(), polyline.is_closed, |index| {
                polyline.vertices[index].bulge
            })
        }
        EntityType::Polyline2D(polyline) => {
            refined_polyline_segment_count(polyline.vertices.len(), polyline.is_closed(), |index| {
                polyline.vertices[index].bulge
            })
        }
        EntityType::Polyline(polyline) => {
            polyline_segment_count(polyline.vertices.len(), polyline.is_closed())
        }
        EntityType::Arc(arc) => normalized_curve_sweep(arc.start_angle, arc.end_angle)
            .filter(|_| arc.radius.is_finite() && arc.radius.abs() > CURVE_EPSILON)
            .map(curve_segment_count)
            .unwrap_or(0),
        EntityType::Circle(circle) => {
            if circle.radius.is_finite() && circle.radius.abs() > CURVE_EPSILON {
                curve_segment_count(std::f64::consts::TAU)
            } else {
                0
            }
        }
        EntityType::Ellipse(ellipse) => {
            if ellipse_axes(ellipse.major_axis, ellipse.normal, ellipse.minor_axis_ratio).is_none()
            {
                return 0;
            }
            normalized_curve_sweep(ellipse.start_parameter, ellipse.end_parameter)
                .map(curve_segment_count)
                .unwrap_or(0)
        }
        EntityType::Spline(spline) => spline_sampling(spline)
            .map(|sampling| sampling.segment_count)
            .unwrap_or_else(|| spline_fallback_segment_count(spline)),
        EntityType::Hatch(hatch) => hatch_boundary_segment_count(hatch),
        _ => 0,
    }
}

fn polyline_segment_count(vertex_count: usize, closed: bool) -> usize {
    vertex_count.saturating_sub(1) + usize::from(closed && vertex_count > 1)
}

fn gpu_segment_geometry(entity: &EntityType, segment_index: usize) -> Option<GpuSegmentGeometry> {
    match entity {
        EntityType::Line(line) if segment_index == 0 => Some(GpuSegmentGeometry {
            start: line.start,
            end: line.end,
            approximated_curve: false,
        }),
        EntityType::LwPolyline(polyline) => {
            let (source_index, refined_index, subdivisions) = refined_polyline_segment(
                segment_index,
                polyline.vertices.len(),
                polyline.is_closed,
                |index| polyline.vertices[index].bulge,
            )?;
            let next_index =
                polyline_next_vertex(source_index, polyline.vertices.len(), polyline.is_closed)?;
            let start_vertex = polyline.vertices.get(source_index)?;
            let end_vertex = polyline.vertices.get(next_index)?;
            let ocs_to_wcs = safe_ocs_matrix(polyline.normal);
            let start = bulge_point(
                start_vertex.location.x,
                start_vertex.location.y,
                end_vertex.location.x,
                end_vertex.location.y,
                polyline.elevation,
                start_vertex.bulge,
                refined_index,
                subdivisions,
            )?;
            let end = bulge_point(
                start_vertex.location.x,
                start_vertex.location.y,
                end_vertex.location.x,
                end_vertex.location.y,
                polyline.elevation,
                start_vertex.bulge,
                refined_index + 1,
                subdivisions,
            )?;
            Some(GpuSegmentGeometry {
                start: ocs_to_wcs * start,
                end: ocs_to_wcs * end,
                approximated_curve: start_vertex.bulge.abs() > CURVE_EPSILON,
            })
        }
        EntityType::Polyline2D(polyline) => {
            let closed = polyline.is_closed();
            let (source_index, refined_index, subdivisions) = refined_polyline_segment(
                segment_index,
                polyline.vertices.len(),
                closed,
                |index| polyline.vertices[index].bulge,
            )?;
            let next_index = polyline_next_vertex(source_index, polyline.vertices.len(), closed)?;
            let start_vertex = polyline.vertices.get(source_index)?;
            let end_vertex = polyline.vertices.get(next_index)?;
            let ocs_to_wcs = safe_ocs_matrix(polyline.normal);
            let start = bulge_point(
                start_vertex.location.x,
                start_vertex.location.y,
                end_vertex.location.x,
                end_vertex.location.y,
                polyline.elevation,
                start_vertex.bulge,
                refined_index,
                subdivisions,
            )?;
            let end = bulge_point(
                start_vertex.location.x,
                start_vertex.location.y,
                end_vertex.location.x,
                end_vertex.location.y,
                polyline.elevation,
                start_vertex.bulge,
                refined_index + 1,
                subdivisions,
            )?;
            Some(GpuSegmentGeometry {
                start: ocs_to_wcs * start,
                end: ocs_to_wcs * end,
                approximated_curve: start_vertex.bulge.abs() > CURVE_EPSILON,
            })
        }
        EntityType::Polyline(polyline) => {
            let next_index =
                polyline_next_vertex(segment_index, polyline.vertices.len(), polyline.is_closed())?;
            Some(GpuSegmentGeometry {
                start: polyline.vertices.get(segment_index)?.location,
                end: polyline.vertices.get(next_index)?.location,
                approximated_curve: false,
            })
        }
        EntityType::Arc(arc) => {
            let sweep = normalized_curve_sweep(arc.start_angle, arc.end_angle)?;
            let segment_count = curve_segment_count(sweep);
            if segment_index >= segment_count
                || !arc.radius.is_finite()
                || arc.radius.abs() <= CURVE_EPSILON
            {
                return None;
            }
            let ocs_to_wcs = safe_ocs_matrix(arc.normal);
            let start_angle = arc.start_angle + sweep * segment_index as f64 / segment_count as f64;
            let end_angle =
                arc.start_angle + sweep * (segment_index + 1) as f64 / segment_count as f64;
            Some(GpuSegmentGeometry {
                start: circular_ocs_point(arc.center, arc.radius, start_angle, ocs_to_wcs),
                end: circular_ocs_point(arc.center, arc.radius, end_angle, ocs_to_wcs),
                approximated_curve: true,
            })
        }
        EntityType::Circle(circle) => {
            let segment_count = curve_segment_count(std::f64::consts::TAU);
            if segment_index >= segment_count
                || !circle.radius.is_finite()
                || circle.radius.abs() <= CURVE_EPSILON
            {
                return None;
            }
            let ocs_to_wcs = safe_ocs_matrix(circle.normal);
            let start_angle = std::f64::consts::TAU * segment_index as f64 / segment_count as f64;
            let end_angle =
                std::f64::consts::TAU * (segment_index + 1) as f64 / segment_count as f64;
            Some(GpuSegmentGeometry {
                start: circular_ocs_point(circle.center, circle.radius, start_angle, ocs_to_wcs),
                end: circular_ocs_point(circle.center, circle.radius, end_angle, ocs_to_wcs),
                approximated_curve: true,
            })
        }
        EntityType::Ellipse(ellipse) => {
            let (major_axis, minor_axis) =
                ellipse_axes(ellipse.major_axis, ellipse.normal, ellipse.minor_axis_ratio)?;
            let sweep = normalized_curve_sweep(ellipse.start_parameter, ellipse.end_parameter)?;
            let segment_count = curve_segment_count(sweep);
            if segment_index >= segment_count {
                return None;
            }
            let start_parameter =
                ellipse.start_parameter + sweep * segment_index as f64 / segment_count as f64;
            let end_parameter =
                ellipse.start_parameter + sweep * (segment_index + 1) as f64 / segment_count as f64;
            Some(GpuSegmentGeometry {
                start: ellipse_point(ellipse.center, major_axis, minor_axis, start_parameter),
                end: ellipse_point(ellipse.center, major_axis, minor_axis, end_parameter),
                approximated_curve: true,
            })
        }
        EntityType::Spline(spline) => {
            if let Some(sampling) = spline_sampling(spline) {
                let (start_parameter, end_parameter) =
                    spline_segment_parameters(spline, sampling, segment_index)?;
                return Some(GpuSegmentGeometry {
                    start: evaluate_spline(spline, sampling, start_parameter)?,
                    end: evaluate_spline(spline, sampling, end_parameter)?,
                    approximated_curve: spline.degree > 1 && !spline.flags.linear,
                });
            }
            let (start, end) = spline_fallback_segment(spline, segment_index)?;
            Some(GpuSegmentGeometry {
                start,
                end,
                approximated_curve: true,
            })
        }
        EntityType::Hatch(hatch) => hatch_boundary_segment(hatch, segment_index),
        _ => None,
    }
}

fn hatch_boundary_segment_count(hatch: &Hatch) -> usize {
    hatch_boundary_segment_limit(hatch).0
}

fn hatch_boundary_segment_limit(hatch: &Hatch) -> (usize, bool) {
    let mut total = 0_usize;
    for edge in hatch.paths.iter().flat_map(|path| &path.edges) {
        let next = total.saturating_add(hatch_edge_segment_count(edge));
        if next > MAX_HATCH_BOUNDARY_SEGMENTS {
            return (MAX_HATCH_BOUNDARY_SEGMENTS, true);
        }
        total = next;
    }
    (total, false)
}

fn hatch_edge_segment_count(edge: &BoundaryEdge) -> usize {
    match edge {
        BoundaryEdge::Line(_) => 1,
        BoundaryEdge::CircularArc(edge) => {
            if !edge.radius.is_finite() || edge.radius.abs() <= CURVE_EPSILON {
                return 0;
            }
            hatch_curve_start_and_sweep(edge.start_angle, edge.end_angle, edge.counter_clockwise)
                .map(|(_, sweep)| curve_segment_count(sweep))
                .unwrap_or(0)
        }
        BoundaryEdge::EllipticArc(edge) => {
            let major_axis =
                Vector3::new(edge.major_axis_endpoint.x, edge.major_axis_endpoint.y, 0.0);
            if ellipse_axes(
                major_axis,
                Vector3::new(0.0, 0.0, 1.0),
                edge.minor_axis_ratio,
            )
            .is_none()
            {
                return 0;
            }
            hatch_curve_start_and_sweep(edge.start_angle, edge.end_angle, edge.counter_clockwise)
                .map(|(_, sweep)| curve_segment_count(sweep))
                .unwrap_or(0)
        }
        BoundaryEdge::Spline(edge) => hatch_spline_sampling(edge)
            .map(|sampling| sampling.segment_count)
            .unwrap_or_else(|| hatch_spline_fallback_segment_count(edge)),
        BoundaryEdge::Polyline(edge) => {
            refined_polyline_segment_count(edge.vertices.len(), edge.is_closed, |index| {
                edge.vertices[index].z
            })
        }
    }
}

fn hatch_curve_start_and_sweep(
    start: f64,
    end: f64,
    counter_clockwise: bool,
) -> Option<(f64, f64)> {
    if counter_clockwise {
        normalized_curve_sweep(start, end).map(|sweep| (start, sweep))
    } else {
        normalized_curve_sweep(end, start).map(|sweep| (end, sweep))
    }
}

fn hatch_boundary_segment(hatch: &Hatch, segment_index: usize) -> Option<GpuSegmentGeometry> {
    if segment_index >= MAX_HATCH_BOUNDARY_SEGMENTS {
        return None;
    }
    let mut remaining = segment_index;
    for edge in hatch.paths.iter().flat_map(|path| &path.edges) {
        let count = hatch_edge_segment_count(edge);
        if remaining < count {
            return hatch_edge_segment(hatch, edge, remaining);
        }
        remaining = remaining.checked_sub(count)?;
    }
    None
}

fn hatch_edge_segment(
    hatch: &Hatch,
    edge: &BoundaryEdge,
    segment_index: usize,
) -> Option<GpuSegmentGeometry> {
    let ocs_to_wcs = safe_ocs_matrix(hatch.normal);
    match edge {
        BoundaryEdge::Line(edge) if segment_index == 0 => Some(GpuSegmentGeometry {
            start: ocs_to_wcs * Vector3::new(edge.start.x, edge.start.y, hatch.elevation),
            end: ocs_to_wcs * Vector3::new(edge.end.x, edge.end.y, hatch.elevation),
            approximated_curve: false,
        }),
        BoundaryEdge::CircularArc(edge) => {
            let (start_parameter, sweep) = hatch_curve_start_and_sweep(
                edge.start_angle,
                edge.end_angle,
                edge.counter_clockwise,
            )?;
            let segment_count = curve_segment_count(sweep);
            if segment_index >= segment_count
                || !edge.radius.is_finite()
                || edge.radius.abs() <= CURVE_EPSILON
            {
                return None;
            }
            let center = Vector3::new(edge.center.x, edge.center.y, hatch.elevation);
            let start_angle = start_parameter + sweep * segment_index as f64 / segment_count as f64;
            let end_angle =
                start_parameter + sweep * (segment_index + 1) as f64 / segment_count as f64;
            Some(GpuSegmentGeometry {
                start: circular_ocs_point(center, edge.radius, start_angle, ocs_to_wcs),
                end: circular_ocs_point(center, edge.radius, end_angle, ocs_to_wcs),
                approximated_curve: true,
            })
        }
        BoundaryEdge::EllipticArc(edge) => {
            let (start_parameter, sweep) = hatch_curve_start_and_sweep(
                edge.start_angle,
                edge.end_angle,
                edge.counter_clockwise,
            )?;
            let major_axis =
                Vector3::new(edge.major_axis_endpoint.x, edge.major_axis_endpoint.y, 0.0);
            let (major_axis, minor_axis) = ellipse_axes(
                major_axis,
                Vector3::new(0.0, 0.0, 1.0),
                edge.minor_axis_ratio,
            )?;
            let segment_count = curve_segment_count(sweep);
            if segment_index >= segment_count {
                return None;
            }
            let center = Vector3::new(edge.center.x, edge.center.y, hatch.elevation);
            let start_parameter =
                start_parameter + sweep * segment_index as f64 / segment_count as f64;
            let end_parameter = start_parameter + sweep / segment_count as f64;
            Some(GpuSegmentGeometry {
                start: ocs_to_wcs * ellipse_point(center, major_axis, minor_axis, start_parameter),
                end: ocs_to_wcs * ellipse_point(center, major_axis, minor_axis, end_parameter),
                approximated_curve: true,
            })
        }
        BoundaryEdge::Spline(edge) => {
            if let Some(sampling) = hatch_spline_sampling(edge) {
                let (start_parameter, end_parameter) =
                    hatch_spline_segment_parameters(edge, sampling, segment_index)?;
                return Some(GpuSegmentGeometry {
                    start: ocs_to_wcs
                        * evaluate_hatch_spline(edge, sampling, start_parameter, hatch.elevation)?,
                    end: ocs_to_wcs
                        * evaluate_hatch_spline(edge, sampling, end_parameter, hatch.elevation)?,
                    approximated_curve: edge.degree > 1,
                });
            }
            let (start, end) = hatch_spline_fallback_segment(edge, segment_index, hatch.elevation)?;
            Some(GpuSegmentGeometry {
                start: ocs_to_wcs * start,
                end: ocs_to_wcs * end,
                approximated_curve: true,
            })
        }
        BoundaryEdge::Polyline(edge) => {
            let (source_index, refined_index, subdivisions) = refined_polyline_segment(
                segment_index,
                edge.vertices.len(),
                edge.is_closed,
                |index| edge.vertices[index].z,
            )?;
            let next_index =
                polyline_next_vertex(source_index, edge.vertices.len(), edge.is_closed)?;
            let start_vertex = edge.vertices.get(source_index)?;
            let end_vertex = edge.vertices.get(next_index)?;
            let start = bulge_point(
                start_vertex.x,
                start_vertex.y,
                end_vertex.x,
                end_vertex.y,
                hatch.elevation,
                start_vertex.z,
                refined_index,
                subdivisions,
            )?;
            let end = bulge_point(
                start_vertex.x,
                start_vertex.y,
                end_vertex.x,
                end_vertex.y,
                hatch.elevation,
                start_vertex.z,
                refined_index + 1,
                subdivisions,
            )?;
            Some(GpuSegmentGeometry {
                start: ocs_to_wcs * start,
                end: ocs_to_wcs * end,
                approximated_curve: start_vertex.z.abs() > CURVE_EPSILON,
            })
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy)]
struct SplineSampling {
    degree: usize,
    nonzero_spans: usize,
    segments_per_span: usize,
    segment_count: usize,
    domain_start: f64,
    domain_end: f64,
    uniform_domain: bool,
}

fn hatch_spline_sampling(edge: &SplineEdge) -> Option<SplineSampling> {
    let degree = usize::try_from(edge.degree).ok()?;
    let control_count = edge.control_points.len();
    if degree == 0
        || degree > MAX_SPLINE_DEGREE
        || control_count <= degree
        || edge.knots.len() < control_count.checked_add(degree)?.checked_add(1)?
        || edge.knots.iter().any(|value| !value.is_finite())
        || edge.knots.windows(2).any(|values| values[0] > values[1])
        || edge
            .control_points
            .iter()
            .any(|point| !point.x.is_finite() || !point.y.is_finite() || !point.z.is_finite())
        || (edge.rational
            && edge
                .control_points
                .iter()
                .all(|point| point.z.abs() <= CURVE_EPSILON))
    {
        return None;
    }
    let domain_start = edge.knots[degree];
    let domain_end = edge.knots[control_count];
    if !domain_start.is_finite()
        || !domain_end.is_finite()
        || domain_end - domain_start <= CURVE_EPSILON
    {
        return None;
    }
    let nonzero_spans = (degree..control_count)
        .filter(|&index| edge.knots[index + 1] - edge.knots[index] > CURVE_EPSILON)
        .count();
    if nonzero_spans == 0 {
        return None;
    }
    let segments_per_span = if degree == 1 {
        1
    } else {
        SPLINE_SEGMENTS_PER_SPAN
    };
    let requested_segments = nonzero_spans.checked_mul(segments_per_span)?;
    Some(SplineSampling {
        degree,
        nonzero_spans,
        segments_per_span,
        segment_count: requested_segments.min(MAX_CURVE_SEGMENTS),
        domain_start,
        domain_end,
        uniform_domain: requested_segments > MAX_CURVE_SEGMENTS,
    })
}

fn hatch_spline_segment_parameters(
    edge: &SplineEdge,
    sampling: SplineSampling,
    segment_index: usize,
) -> Option<(f64, f64)> {
    if segment_index >= sampling.segment_count {
        return None;
    }
    if sampling.uniform_domain {
        let scale = (sampling.domain_end - sampling.domain_start) / sampling.segment_count as f64;
        return Some((
            sampling.domain_start + scale * segment_index as f64,
            sampling.domain_start + scale * (segment_index + 1) as f64,
        ));
    }

    let span_ordinal = segment_index / sampling.segments_per_span;
    let subdivision = segment_index % sampling.segments_per_span;
    if span_ordinal >= sampling.nonzero_spans {
        return None;
    }
    let mut current_span = 0_usize;
    for knot_index in sampling.degree..edge.control_points.len() {
        let span_start = edge.knots[knot_index];
        let span_end = edge.knots[knot_index + 1];
        if span_end - span_start <= CURVE_EPSILON {
            continue;
        }
        if current_span == span_ordinal {
            let scale = (span_end - span_start) / sampling.segments_per_span as f64;
            return Some((
                span_start + scale * subdivision as f64,
                span_start + scale * (subdivision + 1) as f64,
            ));
        }
        current_span += 1;
    }
    None
}

fn evaluate_hatch_spline(
    edge: &SplineEdge,
    sampling: SplineSampling,
    parameter: f64,
    elevation: f64,
) -> Option<Vector3> {
    let control_count = edge.control_points.len();
    let span = if parameter >= sampling.domain_end - CURVE_EPSILON {
        control_count - 1
    } else {
        (sampling.degree..control_count)
            .find(|&index| edge.knots[index] <= parameter && parameter < edge.knots[index + 1])?
    };
    let mut points = [Vector3::ZERO; MAX_SPLINE_DEGREE + 1];
    let mut weights = [0.0_f64; MAX_SPLINE_DEGREE + 1];
    for index in 0..=sampling.degree {
        let control_index = span.checked_sub(sampling.degree)?.checked_add(index)?;
        let control = edge.control_points.get(control_index)?;
        let weight = if edge.rational { control.z } else { 1.0 };
        if !control.x.is_finite()
            || !control.y.is_finite()
            || !elevation.is_finite()
            || !weight.is_finite()
        {
            return None;
        }
        points[index] = Vector3::new(control.x, control.y, elevation) * weight;
        weights[index] = weight;
    }

    for level in 1..=sampling.degree {
        for index in (level..=sampling.degree).rev() {
            let knot_index = span - sampling.degree + index;
            let denominator =
                edge.knots[knot_index + sampling.degree - level + 1] - edge.knots[knot_index];
            let alpha = if denominator.abs() <= CURVE_EPSILON {
                0.0
            } else {
                ((parameter - edge.knots[knot_index]) / denominator).clamp(0.0, 1.0)
            };
            points[index] = points[index - 1] * (1.0 - alpha) + points[index] * alpha;
            weights[index] = weights[index - 1] * (1.0 - alpha) + weights[index] * alpha;
        }
    }
    let weight = weights[sampling.degree];
    if !weight.is_finite() || weight.abs() <= CURVE_EPSILON {
        return None;
    }
    Some(points[sampling.degree] / weight)
}

fn hatch_spline_fallback_segment_count(edge: &SplineEdge) -> usize {
    let point_count = if edge.fit_points.len() >= 2 {
        edge.fit_points.len()
    } else {
        edge.control_points.len()
    };
    polyline_segment_count(point_count, edge.periodic).min(MAX_CURVE_SEGMENTS)
}

fn hatch_spline_fallback_segment(
    edge: &SplineEdge,
    segment_index: usize,
    elevation: f64,
) -> Option<(Vector3, Vector3)> {
    let use_fit_points = edge.fit_points.len() >= 2;
    let point_count = if use_fit_points {
        edge.fit_points.len()
    } else {
        edge.control_points.len()
    };
    let source_segments = polyline_segment_count(point_count, edge.periodic);
    let output_segments = source_segments.min(MAX_CURVE_SEGMENTS);
    if output_segments == 0 || segment_index >= output_segments {
        return None;
    }
    let start_index = segment_index * source_segments / output_segments % point_count;
    let end_index = (segment_index + 1) * source_segments / output_segments % point_count;
    let point = |index: usize| {
        if use_fit_points {
            let value = edge.fit_points.get(index)?;
            Some(Vector3::new(value.x, value.y, elevation))
        } else {
            let value = edge.control_points.get(index)?;
            Some(Vector3::new(value.x, value.y, elevation))
        }
    };
    Some((point(start_index)?, point(end_index)?))
}

fn curve_segment_count(sweep: f64) -> usize {
    if !sweep.is_finite() || sweep.abs() <= CURVE_EPSILON {
        return 0;
    }
    ((sweep.abs() / CURVE_MAX_ANGLE_RADIANS).ceil() as usize).clamp(1, MAX_CURVE_SEGMENTS)
}

fn normalized_curve_sweep(start: f64, end: f64) -> Option<f64> {
    if !start.is_finite() || !end.is_finite() {
        return None;
    }
    let raw = end - start;
    if raw.abs() >= std::f64::consts::TAU - CURVE_EPSILON {
        return Some(std::f64::consts::TAU);
    }
    let sweep = raw.rem_euclid(std::f64::consts::TAU);
    (sweep > CURVE_EPSILON).then_some(sweep)
}

fn refined_polyline_segment_count<F>(vertex_count: usize, closed: bool, bulge_at: F) -> usize
where
    F: Fn(usize) -> f64,
{
    (0..polyline_segment_count(vertex_count, closed))
        .map(|index| bulge_segment_count(bulge_at(index)))
        .fold(0_usize, usize::saturating_add)
}

fn refined_polyline_segment<F>(
    segment_index: usize,
    vertex_count: usize,
    closed: bool,
    bulge_at: F,
) -> Option<(usize, usize, usize)>
where
    F: Fn(usize) -> f64,
{
    let mut remaining = segment_index;
    for source_index in 0..polyline_segment_count(vertex_count, closed) {
        let subdivisions = bulge_segment_count(bulge_at(source_index));
        if remaining < subdivisions {
            return Some((source_index, remaining, subdivisions));
        }
        remaining = remaining.checked_sub(subdivisions)?;
    }
    None
}

fn bulge_segment_count(bulge: f64) -> usize {
    if !bulge.is_finite() || bulge.abs() <= CURVE_EPSILON {
        return 1;
    }
    curve_segment_count(4.0 * bulge.atan().abs()).max(1)
}

#[allow(clippy::too_many_arguments)]
fn bulge_point(
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    elevation: f64,
    bulge: f64,
    subdivision_index: usize,
    subdivisions: usize,
) -> Option<Vector3> {
    if subdivisions == 0 || subdivision_index > subdivisions {
        return None;
    }
    let fraction = subdivision_index as f64 / subdivisions as f64;
    if !bulge.is_finite() {
        return None;
    }
    if bulge.abs() <= CURVE_EPSILON {
        return Some(Vector3::new(
            start_x + (end_x - start_x) * fraction,
            start_y + (end_y - start_y) * fraction,
            elevation,
        ));
    }

    let delta_x = end_x - start_x;
    let delta_y = end_y - start_y;
    let chord = delta_x.hypot(delta_y);
    if !chord.is_finite() || chord <= CURVE_EPSILON {
        return Some(Vector3::new(start_x, start_y, elevation));
    }
    let center_offset = chord * (1.0 - bulge * bulge) / (4.0 * bulge);
    let center_x = (start_x + end_x) * 0.5 - delta_y / chord * center_offset;
    let center_y = (start_y + end_y) * 0.5 + delta_x / chord * center_offset;
    let radius = (start_x - center_x).hypot(start_y - center_y);
    let start_angle = (start_y - center_y).atan2(start_x - center_x);
    let angle = start_angle + 4.0 * bulge.atan() * fraction;
    Some(Vector3::new(
        center_x + radius * angle.cos(),
        center_y + radius * angle.sin(),
        elevation,
    ))
}

fn circular_ocs_point(center: Vector3, radius: f64, angle: f64, ocs_to_wcs: Matrix3) -> Vector3 {
    ocs_to_wcs
        * Vector3::new(
            center.x + radius * angle.cos(),
            center.y + radius * angle.sin(),
            center.z,
        )
}

fn ellipse_axes(
    major_axis: Vector3,
    normal: Vector3,
    minor_axis_ratio: f64,
) -> Option<(Vector3, Vector3)> {
    let major_length = major_axis.length();
    if !vector_is_finite(major_axis)
        || !vector_is_finite(normal)
        || !minor_axis_ratio.is_finite()
        || major_length <= CURVE_EPSILON
        || minor_axis_ratio.abs() <= CURVE_EPSILON
        || normal.length_squared() <= CURVE_EPSILON
    {
        return None;
    }
    let minor_direction = normal.normalize().cross(&major_axis).normalize();
    if minor_direction.length_squared() <= CURVE_EPSILON {
        return None;
    }
    Some((
        major_axis,
        minor_direction * (major_length * minor_axis_ratio.abs()),
    ))
}

fn ellipse_point(
    center: Vector3,
    major_axis: Vector3,
    minor_axis: Vector3,
    parameter: f64,
) -> Vector3 {
    center + major_axis * parameter.cos() + minor_axis * parameter.sin()
}

fn spline_sampling(spline: &acadrust::entities::Spline) -> Option<SplineSampling> {
    let degree = usize::try_from(spline.degree).ok()?;
    let control_count = spline.control_points.len();
    if degree == 0
        || degree > MAX_SPLINE_DEGREE
        || control_count <= degree
        || spline.knots.len() < control_count.checked_add(degree)?.checked_add(1)?
        || spline.knots.iter().any(|value| !value.is_finite())
        || spline.knots.windows(2).any(|values| values[0] > values[1])
        || (!spline.weights.is_empty() && spline.weights.len() != control_count)
        || spline.weights.iter().any(|value| !value.is_finite())
        || (!spline.weights.is_empty()
            && spline
                .weights
                .iter()
                .all(|value| value.abs() <= CURVE_EPSILON))
    {
        return None;
    }
    let domain_start = spline.knots[degree];
    let domain_end = spline.knots[control_count];
    if !domain_start.is_finite()
        || !domain_end.is_finite()
        || domain_end - domain_start <= CURVE_EPSILON
    {
        return None;
    }
    let nonzero_spans = (degree..control_count)
        .filter(|&index| spline.knots[index + 1] - spline.knots[index] > CURVE_EPSILON)
        .count();
    if nonzero_spans == 0 {
        return None;
    }
    let segments_per_span = if spline.degree == 1 || spline.flags.linear {
        1
    } else {
        SPLINE_SEGMENTS_PER_SPAN
    };
    let requested_segments = nonzero_spans.checked_mul(segments_per_span)?;
    let segment_count = requested_segments.min(MAX_CURVE_SEGMENTS);
    Some(SplineSampling {
        degree,
        nonzero_spans,
        segments_per_span,
        segment_count,
        domain_start,
        domain_end,
        uniform_domain: requested_segments > MAX_CURVE_SEGMENTS,
    })
}

fn spline_segment_parameters(
    spline: &acadrust::entities::Spline,
    sampling: SplineSampling,
    segment_index: usize,
) -> Option<(f64, f64)> {
    if segment_index >= sampling.segment_count {
        return None;
    }
    if sampling.uniform_domain {
        let scale = (sampling.domain_end - sampling.domain_start) / sampling.segment_count as f64;
        return Some((
            sampling.domain_start + scale * segment_index as f64,
            sampling.domain_start + scale * (segment_index + 1) as f64,
        ));
    }

    let span_ordinal = segment_index / sampling.segments_per_span;
    let subdivision = segment_index % sampling.segments_per_span;
    if span_ordinal >= sampling.nonzero_spans {
        return None;
    }
    let mut current_span = 0_usize;
    for knot_index in sampling.degree..spline.control_points.len() {
        let span_start = spline.knots[knot_index];
        let span_end = spline.knots[knot_index + 1];
        if span_end - span_start <= CURVE_EPSILON {
            continue;
        }
        if current_span == span_ordinal {
            let scale = (span_end - span_start) / sampling.segments_per_span as f64;
            return Some((
                span_start + scale * subdivision as f64,
                span_start + scale * (subdivision + 1) as f64,
            ));
        }
        current_span += 1;
    }
    None
}

fn evaluate_spline(
    spline: &acadrust::entities::Spline,
    sampling: SplineSampling,
    parameter: f64,
) -> Option<Vector3> {
    let control_count = spline.control_points.len();
    let span = if parameter >= sampling.domain_end - CURVE_EPSILON {
        control_count - 1
    } else {
        (sampling.degree..control_count).find(|&index| {
            spline.knots[index] <= parameter && parameter < spline.knots[index + 1]
        })?
    };
    let mut points = [Vector3::ZERO; MAX_SPLINE_DEGREE + 1];
    let mut weights = [0.0_f64; MAX_SPLINE_DEGREE + 1];
    let has_weights = spline.weights.len() == control_count;
    for index in 0..=sampling.degree {
        let control_index = span.checked_sub(sampling.degree)?.checked_add(index)?;
        let control = *spline.control_points.get(control_index)?;
        let weight = if has_weights {
            *spline.weights.get(control_index)?
        } else {
            1.0
        };
        if !vector_is_finite(control) || !weight.is_finite() {
            return None;
        }
        points[index] = control * weight;
        weights[index] = weight;
    }

    for level in 1..=sampling.degree {
        for index in (level..=sampling.degree).rev() {
            let knot_index = span - sampling.degree + index;
            let denominator =
                spline.knots[knot_index + sampling.degree - level + 1] - spline.knots[knot_index];
            let alpha = if denominator.abs() <= CURVE_EPSILON {
                0.0
            } else {
                ((parameter - spline.knots[knot_index]) / denominator).clamp(0.0, 1.0)
            };
            points[index] = points[index - 1] * (1.0 - alpha) + points[index] * alpha;
            weights[index] = weights[index - 1] * (1.0 - alpha) + weights[index] * alpha;
        }
    }
    let weight = weights[sampling.degree];
    if !weight.is_finite() || weight.abs() <= CURVE_EPSILON {
        return None;
    }
    Some(points[sampling.degree] / weight)
}

fn spline_fallback_segment_count(spline: &acadrust::entities::Spline) -> usize {
    let point_count = if spline.fit_points.len() >= 2 {
        spline.fit_points.len()
    } else {
        spline.control_points.len()
    };
    polyline_segment_count(point_count, spline.flags.closed).min(MAX_CURVE_SEGMENTS)
}

fn spline_fallback_segment(
    spline: &acadrust::entities::Spline,
    segment_index: usize,
) -> Option<(Vector3, Vector3)> {
    let points = if spline.fit_points.len() >= 2 {
        &spline.fit_points
    } else {
        &spline.control_points
    };
    let source_segments = polyline_segment_count(points.len(), spline.flags.closed);
    let output_segments = source_segments.min(MAX_CURVE_SEGMENTS);
    if output_segments == 0 || segment_index >= output_segments {
        return None;
    }
    let start_index = segment_index * source_segments / output_segments;
    let end_index = (segment_index + 1) * source_segments / output_segments;
    Some((
        *points.get(start_index % points.len())?,
        *points.get(end_index % points.len())?,
    ))
}

fn polyline_next_vertex(segment_index: usize, vertex_count: usize, closed: bool) -> Option<usize> {
    let segment_count = polyline_segment_count(vertex_count, closed);
    if segment_index >= segment_count {
        return None;
    }
    Some((segment_index + 1) % vertex_count)
}

fn safe_ocs_matrix(normal: Vector3) -> Matrix3 {
    let length_squared = normal.x * normal.x + normal.y * normal.y + normal.z * normal.z;
    if vector_is_finite(normal) && length_squared.is_finite() && length_squared > 1.0e-24 {
        Matrix3::arbitrary_axis(normal)
    } else {
        Matrix3::identity()
    }
}

fn gpu_segment_is_finite(geometry: &GpuSegmentGeometry) -> bool {
    vector_is_finite(geometry.start) && vector_is_finite(geometry.end)
}

fn vector_is_finite(vector: Vector3) -> bool {
    vector.x.is_finite() && vector.y.is_finite() && vector.z.is_finite()
}

fn morton_key(x: f64, y: f64, bounds: FiniteBounds2) -> u32 {
    let x = quantize_morton_axis(x, bounds.min_x, bounds.max_x);
    let y = quantize_morton_axis(y, bounds.min_y, bounds.max_y);
    interleave_u16(x) | (interleave_u16(y) << 1)
}

fn quantize_morton_axis(value: f64, minimum: f64, maximum: f64) -> u16 {
    let span = maximum - minimum;
    if !span.is_finite() || span <= 0.0 {
        return 0;
    }
    let normalized = ((value - minimum) / span).clamp(0.0, 1.0);
    (normalized * f64::from(u16::MAX)).round() as u16
}

fn interleave_u16(value: u16) -> u32 {
    let mut value = u32::from(value);
    value = (value | (value << 8)) & 0x00ff_00ff;
    value = (value | (value << 4)) & 0x0f0f_0f0f;
    value = (value | (value << 2)) & 0x3333_3333;
    (value | (value << 1)) & 0x5555_5555
}

fn rebased_coordinate(value: f64, origin: f64) -> Result<f32> {
    let rebased = (value - origin) as f32;
    if !rebased.is_finite() {
        anyhow::bail!("GPU line coordinate cannot be represented as a finite f32");
    }
    Ok(rebased)
}

fn rebased_position_error_bound(bounds: FiniteBounds3, origin: Vector3) -> Result<f64> {
    let extrema = [
        (bounds.min.x, bounds.max.x, origin.x),
        (bounds.min.y, bounds.max.y, origin.y),
        (bounds.min.z, bounds.max.z, origin.z),
    ];
    let mut maximum = 0.0_f64;
    for (minimum, maximum_value, origin_value) in extrema {
        rebased_coordinate(minimum, origin_value)?;
        rebased_coordinate(maximum_value, origin_value)?;
        let magnitude = (minimum - origin_value)
            .abs()
            .max((maximum_value - origin_value).abs());
        let quantization_error = magnitude * f64::from(f32::EPSILON);
        let reconstruction_error =
            (origin_value.abs() + magnitude) * f64::EPSILON + f64::from(f32::from_bits(1));
        maximum = maximum.max(quantization_error + reconstruction_error);
    }
    Ok(maximum)
}

fn round_up_f32(value: f64) -> Result<f32> {
    if !value.is_finite() || value < 0.0 {
        anyhow::bail!("value is not a finite non-negative number");
    }
    let rounded = value as f32;
    if !rounded.is_finite() {
        anyhow::bail!("value cannot be represented as a finite f32");
    }
    Ok(if f64::from(rounded) < value {
        f32::from_bits(rounded.to_bits() + 1)
    } else {
        rounded
    })
}

fn write_common<W: Write>(
    writer: &mut W,
    entity: &EntityType,
    layer_indices: &HashMap<String, u32>,
) -> Result<()> {
    write_common_data(writer, entity.common(), layer_indices)
}

fn write_common_data<W: Write>(
    writer: &mut W,
    common: &EntityCommon,
    layer_indices: &HashMap<String, u32>,
) -> Result<()> {
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

fn write_f32<W: Write>(writer: &mut W, value: f32) -> Result<()> {
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

fn slice_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("f32 slice"))
}

fn slice_f64(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("f64 slice"))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use acadrust::entities::{
        Arc, AttributeDefinition, AttributeEntity, BoundaryEdge, BoundaryPath, Circle,
        CircularArcEdge, Dimension, DimensionLinear, Ellipse, EntityType, Face3D, Hatch,
        HatchPatternLine, Insert, InvisibleEdgeFlags, Line, LineEdge, LwPolyline, MText, Point,
        PolylineEdge, Solid, Spline, Text,
    };
    use acadrust::tables::BlockRecord;
    use acadrust::types::{Color, Vector2, Vector3};

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
        assert_eq!(read_u16(&bytes, 10), CACHE_VERSION_MINOR);
        assert_eq!(read_u32(&bytes, 12), HEADER_SIZE);
        assert_eq!(read_u32(&bytes, 16), 30);
        assert_eq!(read_u64(&bytes, 48), 1234);
        assert_eq!(summary.counts.serialized_entities, 7);
        assert_eq!(summary.gpu_lines.model_segments, 43);
        assert_eq!(summary.gpu_lines.overview_segments, 43);
        assert_eq!(summary.gpu_lines.block_segments, 0);
        assert_eq!(summary.gpu_lines.vertices, 86);
        assert_eq!(summary.gpu_lines.approximated_curve_segments, 40);

        let validation =
            validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();
        assert_eq!(validation.sections.len(), 30);
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

        let gpu_batches = directory_entry(&bytes, SectionKind::GpuLineBatches);
        assert_eq!(gpu_batches.1, GPU_LINE_BATCH_RECORD_SIZE);
        assert_eq!(gpu_batches.3, 1);
        let gpu_vertices = directory_entry(&bytes, SectionKind::GpuLineVertices);
        assert_eq!(gpu_vertices.1, GPU_LINE_VERTEX_RECORD_SIZE);
        assert_eq!(gpu_vertices.3, 86);
    }

    #[test]
    fn korean_text_styles_attributes_and_mtext_columns_are_lossless() {
        let mut document = CadDocument::new();
        let style = document.text_styles.get_mut("Standard").unwrap();
        style.font_file = "txt.shx".to_string();
        style.big_font_file = "ksc.shx".to_string();
        style.true_type_font = "맑은 고딕".to_string();

        let mut text = Text::with_value("한글 주석", Vector3::new(1.0, 2.0, 0.0));
        text.style = "Standard".to_string();
        document.add_entity(EntityType::Text(text)).unwrap();

        let mut mtext = MText::with_value("{\\H1.2x;배관}\\P점검", Vector3::new(3.0, 4.0, 0.0));
        mtext.column_data.column_type = 2;
        mtext.column_data.column_count = 2;
        mtext.column_data.width = 20.0;
        mtext.column_data.gutter = 2.0;
        mtext.column_data.heights = vec![10.0, 11.0];
        document.add_entity(EntityType::MText(mtext)).unwrap();

        document
            .add_entity(EntityType::AttributeDefinition(AttributeDefinition::new(
                "도면번호".to_string(),
                "번호 입력".to_string(),
                "가-001".to_string(),
            )))
            .unwrap();
        let mut insert = Insert::new("*Model_Space", Vector3::ZERO);
        insert.attributes.push(AttributeEntity::new(
            "도면번호".to_string(),
            "나-002".to_string(),
        ));
        document.add_entity(EntityType::Insert(insert)).unwrap();

        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 321).unwrap();
        let bytes = cursor.into_inner();
        validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();

        assert_eq!(summary.counts.texts, 1);
        assert_eq!(summary.counts.mtexts, 1);
        assert_eq!(summary.counts.attribute_definitions, 1);
        assert_eq!(summary.counts.attributes, 1);
        assert_eq!(summary.counts.serialized_entities, 4);

        let styles = directory_entry(&bytes, SectionKind::TextStyles);
        assert_eq!(styles.1, TEXT_STYLE_RECORD_SIZE);
        let style_section = styles.2 as usize;
        let style_strings =
            style_section + usize::try_from(read_u64(&bytes, style_section + 8)).unwrap();
        assert_eq!(
            read_cache_string(&bytes, style_section + 16 + 16, style_strings),
            "txt.shx"
        );
        assert_eq!(
            read_cache_string(&bytes, style_section + 16 + 24, style_strings),
            "ksc.shx"
        );
        assert_eq!(
            read_cache_string(&bytes, style_section + 16 + 32, style_strings),
            "맑은 고딕"
        );

        let texts = directory_entry(&bytes, SectionKind::TextEntities);
        assert_eq!(texts.1, TEXT_ENTITY_RECORD_SIZE);
        assert_eq!(texts.3, 4);
        let text_section = texts.2 as usize;
        let text_strings =
            text_section + usize::try_from(read_u64(&bytes, text_section + 8)).unwrap();
        let values: Vec<_> = (0..4)
            .map(|index| {
                read_cache_string(
                    &bytes,
                    text_section + 16 + index * TEXT_ENTITY_RECORD_SIZE as usize + 40,
                    text_strings,
                )
            })
            .collect();
        assert_eq!(
            values,
            ["한글 주석", "{\\H1.2x;배관}\\P점검", "가-001", "나-002"]
        );

        let heights = directory_entry(&bytes, SectionKind::TextColumnHeights);
        assert_eq!(heights.3, 2);
        assert_eq!(read_f64(&bytes, heights.2 as usize), 10.0);
        assert_eq!(read_f64(&bytes, heights.2 as usize + 8), 11.0);
    }

    #[test]
    fn analytic_curves_are_tessellated_with_bounded_segments() {
        let arc = EntityType::Arc(Arc::from_coords(
            0.0,
            0.0,
            0.0,
            10.0,
            0.0,
            std::f64::consts::PI,
        ));
        let circle = EntityType::Circle(Circle::from_coords(0.0, 0.0, 0.0, 10.0));
        let ellipse = EntityType::Ellipse(Ellipse::from_center_axes(
            Vector3::ZERO,
            Vector3::new(10.0, 0.0, 0.0),
            0.5,
        ));
        let spline = EntityType::Spline(Spline::from_control_points(
            3,
            vec![
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 0.0),
                Vector3::new(2.0, 1.0, 0.0),
                Vector3::new(3.0, 0.0, 0.0),
            ],
        ));

        assert_eq!(gpu_entity_segment_count(&arc), 8);
        assert_eq!(gpu_entity_segment_count(&circle), 16);
        assert_eq!(gpu_entity_segment_count(&ellipse), 16);
        assert_eq!(gpu_entity_segment_count(&spline), 2);
        assert!(gpu_entity_segment_count(&spline) <= MAX_CURVE_SEGMENTS);

        let arc_start = gpu_segment_geometry(&arc, 0).unwrap().start;
        let arc_end = gpu_segment_geometry(&arc, 7).unwrap().end;
        assert!((arc_start.x - 10.0).abs() < 1.0e-9);
        assert!(arc_start.y.abs() < 1.0e-9);
        assert!((arc_end.x + 10.0).abs() < 1.0e-9);
        assert!(arc_end.y.abs() < 1.0e-9);

        let spline_midpoint = gpu_segment_geometry(&spline, 0).unwrap().end;
        assert!((spline_midpoint.x - 1.5).abs() < 1.0e-9);
        assert!((spline_midpoint.y - 0.75).abs() < 1.0e-9);
    }

    #[test]
    fn hatch_boundaries_are_bounded_ocs_gpu_lines() {
        let mut hatch = Hatch::new();
        let mut path = BoundaryPath::new();
        path.add_edge(BoundaryEdge::Line(LineEdge {
            start: Vector2::new(0.0, 0.0),
            end: Vector2::new(2.0, 0.0),
        }));
        path.add_edge(BoundaryEdge::CircularArc(CircularArcEdge {
            center: Vector2::new(2.0, 1.0),
            radius: 1.0,
            start_angle: -std::f64::consts::FRAC_PI_2,
            end_angle: std::f64::consts::FRAC_PI_2,
            counter_clockwise: true,
        }));
        path.add_edge(BoundaryEdge::Polyline(PolylineEdge {
            vertices: vec![Vector3::new(2.0, 2.0, 1.0), Vector3::new(0.0, 2.0, 0.0)],
            is_closed: false,
        }));
        hatch.add_path(path);
        let entity = EntityType::Hatch(hatch);

        assert_eq!(gpu_entity_segment_count(&entity), 17);
        let line = gpu_segment_geometry(&entity, 0).unwrap();
        assert_eq!(line.start, Vector3::new(0.0, 0.0, 0.0));
        assert_eq!(line.end, Vector3::new(2.0, 0.0, 0.0));
        assert!(!line.approximated_curve);
        let arc_end = gpu_segment_geometry(&entity, 8).unwrap().end;
        assert!((arc_end.x - 2.0).abs() < 1.0e-9);
        assert!((arc_end.y - 2.0).abs() < 1.0e-9);
        assert!(gpu_segment_geometry(&entity, 17).is_none());

        let mut document = CadDocument::new();
        document.add_entity(entity).unwrap();
        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 0).unwrap();
        let bytes = cursor.into_inner();
        assert_eq!(summary.counts.serialized_entities, 1);
        assert_eq!(summary.counts.deferred_entities, 0);
        assert_eq!(summary.gpu_lines.model_segments, 17);
        assert_eq!(summary.gpu_lines.hatch_boundary_segments, 17);
        assert_eq!(summary.gpu_lines.truncated_hatch_entities, 0);
        assert_eq!(summary.hatch_fills.source_hatches, 1);
        assert_eq!(summary.hatch_fills.fill_loops, 0);
        assert_eq!(summary.hatch_fills.skipped_open_paths, 1);
        let vertices = directory_entry(&bytes, SectionKind::GpuLineVertices);
        let style = read_u32(&bytes, vertices.2 as usize + 28);
        assert_eq!((style >> GPU_STYLE_SOURCE_KIND_SHIFT) & 0xf, 8);
    }

    #[test]
    fn closed_gradient_hatch_preserves_bounded_source_and_fill_rings() {
        let mut hatch = Hatch::new();
        hatch.gradient_color.enabled = true;
        hatch.gradient_color.name = "LINEAR".to_owned();
        hatch.gradient_color.angle = std::f64::consts::FRAC_PI_4;
        hatch
            .gradient_color
            .add_color(0.0, Color::Rgb { r: 255, g: 0, b: 0 });
        hatch
            .gradient_color
            .add_color(1.0, Color::Rgb { r: 0, g: 0, b: 255 });
        hatch.add_seed_point(Vector2::new(1.0, 1.0));
        let mut path = BoundaryPath::external();
        for (start, end) in [
            ((0.0, 0.0), (2.0, 0.0)),
            ((2.0, 0.0), (2.0, 2.0)),
            ((2.0, 2.0), (0.0, 2.0)),
            ((0.0, 2.0), (0.0, 0.0)),
        ] {
            path.add_edge(BoundaryEdge::Line(LineEdge {
                start: Vector2::new(start.0, start.1),
                end: Vector2::new(end.0, end.1),
            }));
        }
        hatch.add_path(path);

        let mut document = CadDocument::new();
        document.add_entity(EntityType::Hatch(hatch)).unwrap();
        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 0).unwrap();
        let bytes = cursor.into_inner();

        assert_eq!(summary.counts.hatches, 1);
        assert_eq!(summary.hatch_fills.source_hatches, 1);
        assert_eq!(summary.hatch_fills.gradient_hatches, 1);
        assert_eq!(summary.hatch_fills.fill_loops, 1);
        assert_eq!(summary.hatch_fills.fill_vertices, 4);
        assert_eq!(summary.hatch_fills.gradient_colors, 2);
        assert_eq!(summary.hatch_fills.seed_points, 1);
        assert_eq!(summary.hatch_fills.truncated_fill_hatches, 0);

        let hatches = directory_entry(&bytes, SectionKind::HatchEntities);
        assert_eq!(hatches.1, HATCH_ENTITY_RECORD_SIZE);
        assert_eq!(hatches.3, 1);
        let hatch_offset = usize::try_from(hatches.2).unwrap() + STRING_TABLE_HEADER_SIZE as usize;
        assert_eq!(
            read_u32(&bytes, hatch_offset + 48) & HATCH_FLAG_GRADIENT,
            HATCH_FLAG_GRADIENT
        );
        assert_eq!(read_u64(&bytes, hatch_offset + 56), 0);
        assert_eq!(read_u64(&bytes, hatch_offset + 64), 1);
        assert_eq!(read_u64(&bytes, hatch_offset + 80), 2);

        let loops = directory_entry(&bytes, SectionKind::HatchLoops);
        assert_eq!(loops.3, 1);
        let loop_offset = usize::try_from(loops.2).unwrap();
        assert_eq!(read_u64(&bytes, loop_offset + 24), 4);
        assert!((read_f64(&bytes, loop_offset + 40) - 4.0).abs() < 1.0e-12);
        let vertices = directory_entry(&bytes, SectionKind::HatchVertices);
        assert_eq!(vertices.3, 4);
        let colors = directory_entry(&bytes, SectionKind::HatchGradientColors);
        assert_eq!(colors.3, 2);
        let seeds = directory_entry(&bytes, SectionKind::HatchSeedPoints);
        assert_eq!(seeds.3, 1);

        validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();
    }

    #[test]
    fn pattern_hatch_preserves_definition_lines_and_dashes() {
        let mut hatch = Hatch::new();
        hatch.is_solid = false;
        hatch.pattern.name = "ANSI31".to_owned();
        hatch.pattern.lines.push(HatchPatternLine {
            angle: std::f64::consts::FRAC_PI_4,
            base_point: Vector2::new(1.0, 2.0),
            offset: Vector2::new(-0.5, 0.5),
            dash_lengths: vec![1.0, -0.5, 0.0],
        });
        let mut path = BoundaryPath::external();
        for (start, end) in [
            ((0.0, 0.0), (4.0, 0.0)),
            ((4.0, 0.0), (4.0, 4.0)),
            ((4.0, 4.0), (0.0, 4.0)),
            ((0.0, 4.0), (0.0, 0.0)),
        ] {
            path.add_edge(BoundaryEdge::Line(LineEdge {
                start: Vector2::new(start.0, start.1),
                end: Vector2::new(end.0, end.1),
            }));
        }
        hatch.add_path(path);

        let mut document = CadDocument::new();
        document.add_entity(EntityType::Hatch(hatch)).unwrap();
        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 0).unwrap();
        let bytes = cursor.into_inner();

        assert_eq!(summary.hatch_fills.pattern_hatches, 1);
        assert_eq!(summary.hatch_fills.pattern_definition_lines, 1);
        assert_eq!(summary.hatch_fills.pattern_dashes, 3);
        assert_eq!(summary.hatch_fills.truncated_pattern_hatches, 0);
        assert_eq!(summary.hatch_fills.skipped_invalid_pattern_lines, 0);

        let lines = directory_entry(&bytes, SectionKind::HatchPatternLines);
        assert_eq!(lines.1, HATCH_PATTERN_LINE_RECORD_SIZE);
        assert_eq!(lines.3, 1);
        let line_offset = usize::try_from(lines.2).unwrap();
        assert_eq!(read_u64(&bytes, line_offset), 0);
        assert_eq!(read_u32(&bytes, line_offset + 8), 0);
        assert!((read_f64(&bytes, line_offset + 16) - std::f64::consts::FRAC_PI_4).abs() < 1.0e-12);
        assert_eq!(read_u64(&bytes, line_offset + 56), 0);
        assert_eq!(read_u32(&bytes, line_offset + 64), 3);

        let dashes = directory_entry(&bytes, SectionKind::HatchPatternDashes);
        assert_eq!(dashes.1, HATCH_PATTERN_DASH_RECORD_SIZE);
        assert_eq!(dashes.3, 3);
        let dash_offset = usize::try_from(dashes.2).unwrap();
        assert_eq!(read_f64(&bytes, dash_offset), 1.0);
        assert_eq!(read_f64(&bytes, dash_offset + 8), -0.5);
        assert_eq!(read_f64(&bytes, dash_offset + 16), 0.0);

        validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();

        let mut invalid = bytes;
        invalid[line_offset + 68..line_offset + 72].copy_from_slice(&1_u32.to_le_bytes());
        let error = validate_scene_cache_reader(Cursor::new(invalid.clone()), invalid.len() as u64)
            .unwrap_err();
        assert!(error.to_string().contains("invalid metadata"));
    }

    #[test]
    fn pathological_hatch_boundaries_report_the_display_cap() {
        let edge = BoundaryEdge::Line(LineEdge {
            start: Vector2::new(0.0, 0.0),
            end: Vector2::new(1.0, 0.0),
        });
        let mut hatch = Hatch::new();
        let mut path = BoundaryPath::new();
        path.edges = vec![edge; MAX_HATCH_BOUNDARY_SEGMENTS + 1];
        hatch.add_path(path);

        assert_eq!(
            hatch_boundary_segment_limit(&hatch),
            (MAX_HATCH_BOUNDARY_SEGMENTS, true)
        );
    }

    #[test]
    fn malformed_spline_fallback_is_bounded_and_reaches_its_endpoint() {
        let control_points = (0..400)
            .map(|index| Vector3::new(f64::from(index), 0.0, 0.0))
            .collect();
        let mut spline = Spline::from_control_points(3, control_points);
        spline.knots.clear();
        let entity = EntityType::Spline(spline);

        assert_eq!(gpu_entity_segment_count(&entity), MAX_CURVE_SEGMENTS);
        let final_segment = gpu_segment_geometry(&entity, MAX_CURVE_SEGMENTS - 1).unwrap();
        assert!((final_segment.end.x - 399.0).abs() < 1.0e-9);
        assert!(gpu_segment_geometry(&entity, MAX_CURVE_SEGMENTS).is_none());
    }

    #[test]
    fn malformed_spline_weights_use_control_point_fallback() {
        let mut spline = Spline::from_control_points(
            2,
            vec![
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 0.0),
                Vector3::new(2.0, 0.0, 0.0),
            ],
        );
        spline.weights = vec![1.0];
        let entity = EntityType::Spline(spline);

        assert_eq!(gpu_entity_segment_count(&entity), 2);
        let first_segment = gpu_segment_geometry(&entity, 0).unwrap();
        assert_eq!(first_segment.start, Vector3::new(0.0, 0.0, 0.0));
        assert_eq!(first_segment.end, Vector3::new(1.0, 1.0, 0.0));
        assert!(first_segment.approximated_curve);
    }

    #[test]
    fn stored_position_error_is_rounded_up() {
        let value = 1.0 + f64::from(f32::EPSILON) * 0.25;
        let encoded = round_up_f32(value).unwrap();

        assert!(f64::from(encoded) >= value);
        assert_eq!(encoded, f32::from_bits(1.0_f32.to_bits() + 1));
    }

    #[test]
    fn polyline_bulges_are_refined_instead_of_drawn_as_one_chord() {
        let mut polyline =
            LwPolyline::from_points(vec![Vector2::new(0.0, 0.0), Vector2::new(2.0, 0.0)]);
        polyline.vertices[0].bulge = 1.0;
        let entity = EntityType::LwPolyline(polyline);

        assert_eq!(gpu_entity_segment_count(&entity), 8);
        let midpoint = gpu_segment_geometry(&entity, 3).unwrap().end;
        assert!((midpoint.x - 1.0).abs() < 1.0e-9);
        assert!((midpoint.y + 1.0).abs() < 1.0e-9);
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
    fn validation_rejects_a_gpu_batch_with_the_wrong_vertex_count() {
        let mut document = CadDocument::new();
        document
            .add_entity(EntityType::Line(Line::from_coords(
                0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
            )))
            .unwrap();
        let mut cursor = Cursor::new(Vec::new());
        write_scene_cache(&mut cursor, &document, 0).unwrap();
        let mut bytes = cursor.into_inner();
        let batches = directory_entry(&bytes, SectionKind::GpuLineBatches);
        let first_vertex_count = usize::try_from(batches.2).unwrap() + 24;
        bytes[first_vertex_count..first_vertex_count + 8].copy_from_slice(&4_u64.to_le_bytes());

        let error = validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64)
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("vertex count does not match its segments"));
    }

    #[test]
    fn local_origin_preserves_small_offsets_at_large_world_coordinates() {
        let mut document = CadDocument::new();
        let base = 1_000_000_000.0;
        document
            .add_entity(EntityType::Line(Line::from_coords(
                base + 0.125,
                base + 0.25,
                0.0,
                base + 0.375,
                base + 0.5,
                0.0,
            )))
            .unwrap();
        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 0).unwrap();
        let bytes = cursor.into_inner();

        assert_eq!((base + 0.125) as f32, (base + 0.375) as f32);
        assert_eq!(summary.gpu_lines.model_segments, 1);
        assert!(summary.gpu_lines.maximum_position_error < 1.0e-6);

        let batches = directory_entry(&bytes, SectionKind::GpuLineBatches);
        let batch_offset = usize::try_from(batches.2).unwrap();
        let origin_x = read_f64(&bytes, batch_offset + 40);
        let origin_y = read_f64(&bytes, batch_offset + 48);
        let vertices = directory_entry(&bytes, SectionKind::GpuLineVertices);
        let vertex_offset = usize::try_from(vertices.2).unwrap();
        let first_x = origin_x + f64::from(read_f32(&bytes, vertex_offset));
        let first_y = origin_y + f64::from(read_f32(&bytes, vertex_offset + 4));
        let second_x = origin_x
            + f64::from(read_f32(
                &bytes,
                vertex_offset + GPU_LINE_VERTEX_RECORD_SIZE as usize,
            ));

        assert!((first_x - (base + 0.125)).abs() < 1.0e-6);
        assert!((first_y - (base + 0.25)).abs() < 1.0e-6);
        assert!((second_x - (base + 0.375)).abs() < 1.0e-6);
        let measured_error = [
            (first_x - (base + 0.125)).abs(),
            (first_y - (base + 0.25)).abs(),
            (second_x - (base + 0.375)).abs(),
        ]
        .into_iter()
        .fold(0.0_f64, f64::max);
        assert!(summary.gpu_lines.maximum_position_error >= measured_error);
    }

    #[test]
    fn block_geometry_is_cached_once_instead_of_per_insert() {
        let mut document = CadDocument::new();
        let block_handle = document.allocate_handle();
        let mut block = BlockRecord::new("TEST_BLOCK");
        block.handle = block_handle;
        document.block_records.add(block).unwrap();

        let mut block_line = Line::from_coords(0.0, 0.0, 0.0, 5.0, 0.0, 0.0);
        block_line.common.owner_handle = block_handle;
        document.add_entity(EntityType::Line(block_line)).unwrap();
        document
            .add_entity(EntityType::Insert(Insert::new(
                "TEST_BLOCK",
                Vector3::new(10.0, 0.0, 0.0),
            )))
            .unwrap();
        document
            .add_entity(EntityType::Insert(Insert::new(
                "TEST_BLOCK",
                Vector3::new(20.0, 0.0, 0.0),
            )))
            .unwrap();

        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 0).unwrap();
        let bytes = cursor.into_inner();
        assert_eq!(summary.gpu_lines.model_segments, 0);
        assert_eq!(summary.gpu_lines.block_segments, 1);
        assert_eq!(summary.gpu_lines.block_batches, 1);
        assert_eq!(summary.gpu_lines.block_overview_batches, 1);
        assert_eq!(summary.gpu_lines.block_detail_batches, 0);
        assert_eq!(summary.gpu_lines.first_frame_vertex_bytes, 64);
        assert_eq!(summary.gpu_lines.vertices, 2);

        let batches = directory_entry(&bytes, SectionKind::GpuLineBatches);
        let batch_offset = usize::try_from(batches.2).unwrap();
        assert_eq!(read_u16(&bytes, batch_offset + 4), 2);
        assert_ne!(read_u32(&bytes, batch_offset + 12), u32::MAX);
    }

    #[test]
    fn dimension_picture_block_reuses_the_block_instance_stream() {
        let mut document = CadDocument::new();
        let owner_handle = document.allocate_handle();
        let mut owner = BlockRecord::new("OWNER");
        owner.handle = owner_handle;
        document.block_records.add(owner).unwrap();

        let picture_handle = document.allocate_handle();
        let mut picture = BlockRecord::new("*D1");
        picture.handle = picture_handle;
        picture.base_point = Vector3::new(3.0, 4.0, 0.0);
        document.block_records.add(picture).unwrap();

        let mut picture_line = Line::from_coords(7.0, 8.0, 0.0, 9.0, 8.0, 0.0);
        picture_line.common.owner_handle = picture_handle;
        document.add_entity(EntityType::Line(picture_line)).unwrap();

        let mut dimension = Dimension::Linear(DimensionLinear::new(
            Vector3::ZERO,
            Vector3::new(2.0, 0.0, 0.0),
        ));
        dimension.base_mut().block_name = "*D1".to_string();
        dimension.base_mut().common.owner_handle = owner_handle;
        document
            .add_entity(EntityType::Dimension(dimension))
            .unwrap();

        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 0).unwrap();
        let bytes = cursor.into_inner();
        validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();

        assert_eq!(summary.counts.inserts, 0);
        assert_eq!(summary.counts.dimensions, 1);
        assert_eq!(summary.counts.serialized_entities, 2);
        assert_eq!(summary.counts.deferred_entities, 0);
        assert_eq!(summary.gpu_lines.block_segments, 1);

        let inserts = directory_entry(&bytes, SectionKind::Inserts);
        assert_eq!(inserts.3, 1);
        let offset = usize::try_from(inserts.2).unwrap();
        let picture_index = document
            .block_records
            .iter()
            .position(|block| block.name == "*D1")
            .unwrap() as u32;
        assert_eq!(read_u64(&bytes, offset + 8), owner_handle.value());
        assert_eq!(read_u32(&bytes, offset + 32), picture_index);
        assert_eq!(read_u16(&bytes, offset + 36), 1);
        assert_eq!(read_u16(&bytes, offset + 38), 1);
        assert_eq!(read_f64(&bytes, offset + 40), 3.0);
        assert_eq!(read_f64(&bytes, offset + 48), 4.0);
        assert_eq!(read_f64(&bytes, offset + 64), 1.0);
        assert_eq!(read_f64(&bytes, offset + 72), 1.0);
        assert_eq!(read_f64(&bytes, offset + 80), 1.0);
        assert_eq!(read_f64(&bytes, offset + 88), 0.0);
        assert_eq!(read_f64(&bytes, offset + 96), 0.0);
        assert_eq!(read_f64(&bytes, offset + 104), 0.0);
        assert_eq!(read_f64(&bytes, offset + 112), 1.0);
    }

    #[test]
    fn unresolved_dimension_picture_block_remains_deferred() {
        let mut document = CadDocument::new();
        let mut dimension = Dimension::Linear(DimensionLinear::new(
            Vector3::ZERO,
            Vector3::new(2.0, 0.0, 0.0),
        ));
        dimension.base_mut().block_name = "*MISSING".to_string();
        document
            .add_entity(EntityType::Dimension(dimension))
            .unwrap();

        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 0).unwrap();
        let bytes = cursor.into_inner();
        let inserts = directory_entry(&bytes, SectionKind::Inserts);

        assert_eq!(summary.counts.dimensions, 0);
        assert_eq!(summary.counts.serialized_entities, 0);
        assert_eq!(summary.counts.deferred_entities, 1);
        assert_eq!(inserts.3, 0);
    }

    #[test]
    fn overview_sampling_is_bounded_and_keeps_both_spatial_ends() {
        let segments: Vec<_> = (0..SCENE_OVERVIEW_SEGMENTS + 17)
            .map(|index| SpatialSegmentRef {
                morton: index as u32,
                entity_index: 0,
                segment_index: 0,
            })
            .collect();
        let overview = sample_spatial_segments(&segments, SCENE_OVERVIEW_SEGMENTS);
        assert_eq!(overview.len(), SCENE_OVERVIEW_SEGMENTS);
        assert_eq!(overview.first().unwrap().morton, 0);
        assert_eq!(
            overview.last().unwrap().morton,
            u32::try_from(segments.len() - 1).unwrap()
        );
    }

    #[test]
    fn overview_budget_keeps_every_nonempty_block_represented() {
        let make_segments = |count: usize, entity_index: u32| {
            (0..count)
                .map(|index| SpatialSegmentRef {
                    morton: index as u32,
                    entity_index,
                    segment_index: 0,
                })
                .collect()
        };
        let groups = vec![
            PreparedGpuEntityGroup {
                kind: GpuEntityGroupKind::Model,
                segments: make_segments(2, 0),
            },
            PreparedGpuEntityGroup {
                kind: GpuEntityGroupKind::Block(2),
                segments: make_segments(20, 1),
            },
            PreparedGpuEntityGroup {
                kind: GpuEntityGroupKind::Block(3),
                segments: make_segments(3, 2),
            },
        ];
        let quotas = allocate_overview_quotas(&groups, 10);
        assert_eq!(quotas.iter().sum::<usize>(), 10);
        assert!(quotas.iter().all(|&quota| quota > 0));
        assert!(quotas
            .iter()
            .zip(&groups)
            .all(|(&quota, group)| quota <= group.segments.len()));
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
    fn point_solid_and_face_are_counted_as_serialized_entities() {
        let mut document = CadDocument::new();
        document
            .add_entity(EntityType::Line(Line::from_coords(
                0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
            )))
            .unwrap();
        document
            .add_entity(EntityType::Point(Point::from_coords(2.0, 3.0, 0.0)))
            .unwrap();
        document
            .add_entity(EntityType::Solid(Solid::triangle(
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(2.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 0.0),
            )))
            .unwrap();
        document
            .add_entity(EntityType::Face3D(Face3D::triangle(
                Vector3::new(0.0, 0.0, 1.0),
                Vector3::new(2.0, 0.0, 1.0),
                Vector3::new(1.0, 1.0, 1.0),
            )))
            .unwrap();

        let block_targets = collect_block_instance_targets(&document).unwrap();
        let counts = PrimitiveCounts::from_document(&document, &block_targets);
        assert_eq!(counts.total_entities, 4);
        assert_eq!(counts.points, 1);
        assert_eq!(counts.solids, 1);
        assert_eq!(counts.faces, 1);
        assert_eq!(counts.serialized_entities, 4);
        assert_eq!(counts.deferred_entities, 0);
    }

    #[test]
    fn point_solid_and_face_source_records_are_lossless() {
        let mut document = CadDocument::new();
        document.header.point_display_mode = 66;
        document.header.point_display_size = -3.5;
        document.header.fill_mode = false;

        let mut point = Point::from_coords(2.0, 3.0, 4.0);
        point.normal = Vector3::new(0.0, 1.0, 0.0);
        point.thickness = 0.75;
        point.x_axis_angle = 0.25;
        point.common.color = Color::Index(3);
        point.common.invisible = true;
        document.add_entity(EntityType::Point(point)).unwrap();

        let mut solid = Solid::new(
            Vector3::new(10.0, 20.0, 2.0),
            Vector3::new(14.0, 20.0, 2.0),
            Vector3::new(14.0, 23.0, 2.0),
            Vector3::new(10.0, 23.0, 2.0),
        );
        solid.normal = Vector3::new(0.0, 0.0, -1.0);
        solid.thickness = 1.25;
        document.add_entity(EntityType::Solid(solid)).unwrap();

        let mut face = Face3D::new(
            Vector3::new(1.0, 2.0, 3.0),
            Vector3::new(4.0, 5.0, 6.0),
            Vector3::new(7.0, 8.0, 9.0),
            Vector3::new(10.0, 11.0, 12.0),
        );
        face.invisible_edges = InvisibleEdgeFlags::from_bits(9);
        face.common.color = Color::Rgb {
            r: 12,
            g: 34,
            b: 56,
        };
        document.add_entity(EntityType::Face3D(face)).unwrap();

        let mut cursor = Cursor::new(Vec::new());
        let summary = write_scene_cache(&mut cursor, &document, 999).unwrap();
        let bytes = cursor.into_inner();
        validate_scene_cache_reader(Cursor::new(bytes.clone()), bytes.len() as u64).unwrap();

        assert_eq!(summary.counts.points, 1);
        assert_eq!(summary.counts.solids, 1);
        assert_eq!(summary.counts.faces, 1);
        assert_eq!(summary.counts.deferred_entities, 0);

        let point_entry = directory_entry(&bytes, SectionKind::PointEntities);
        assert_eq!(point_entry.1, POINT_ENTITY_RECORD_SIZE);
        assert_eq!(point_entry.3, 1);
        let point_offset = point_entry.2 as usize;
        assert_eq!(read_u16(&bytes, point_offset + 26), 1);
        assert_eq!(read_f64(&bytes, point_offset + 32), 2.0);
        assert_eq!(read_f64(&bytes, point_offset + 48), 4.0);
        assert_eq!(read_f64(&bytes, point_offset + 64), 1.0);
        assert_eq!(read_f64(&bytes, point_offset + 80), 0.75);
        assert_eq!(read_f64(&bytes, point_offset + 88), 0.25);
        assert_eq!(read_f64(&bytes, point_offset + 96), -3.5);
        assert_eq!(
            i16::from_le_bytes(
                bytes[point_offset + 104..point_offset + 106]
                    .try_into()
                    .unwrap()
            ),
            66
        );

        let solid_entry = directory_entry(&bytes, SectionKind::SolidEntities);
        assert_eq!(solid_entry.1, SOLID_ENTITY_RECORD_SIZE);
        assert_eq!(solid_entry.3, 1);
        let solid_offset = solid_entry.2 as usize;
        assert_eq!(read_u32(&bytes, solid_offset + 32), 0);
        assert_eq!(read_f64(&bytes, solid_offset + 40), 10.0);
        assert_eq!(read_f64(&bytes, solid_offset + 64), 14.0);
        assert_eq!(read_f64(&bytes, solid_offset + 112), 10.0);
        assert_eq!(read_f64(&bytes, solid_offset + 152), -1.0);
        assert_eq!(read_f64(&bytes, solid_offset + 160), 1.25);

        let face_entry = directory_entry(&bytes, SectionKind::FaceEntities);
        assert_eq!(face_entry.1, FACE_ENTITY_RECORD_SIZE);
        assert_eq!(face_entry.3, 1);
        let face_offset = face_entry.2 as usize;
        assert_eq!(read_u32(&bytes, face_offset + 20), (3 << 30) | 0x0c2238);
        assert_eq!(read_u32(&bytes, face_offset + 32), 9);
        assert_eq!(read_u32(&bytes, face_offset + 36), 0);
        assert_eq!(read_f64(&bytes, face_offset + 40), 1.0);
        assert_eq!(read_f64(&bytes, face_offset + 64), 4.0);
        assert_eq!(read_f64(&bytes, face_offset + 88), 7.0);
        assert_eq!(read_f64(&bytes, face_offset + 112), 10.0);
        assert_eq!(read_f64(&bytes, face_offset + 128), 12.0);
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

    fn read_cache_string(bytes: &[u8], reference_offset: usize, string_blob: usize) -> &str {
        let relative = read_u32(bytes, reference_offset) as usize;
        let length = read_u32(bytes, reference_offset + 4) as usize;
        std::str::from_utf8(&bytes[string_blob + relative..string_blob + relative + length])
            .unwrap()
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

    fn read_f32(bytes: &[u8], offset: usize) -> f32 {
        f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }
}
