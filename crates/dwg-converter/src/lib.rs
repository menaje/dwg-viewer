use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use acadrust::entities::EntityType;
use anyhow::{Context, Result};
use serde::Serialize;

pub mod benchmark;
mod engine;
pub mod scene_cache;

const REPORT_SCHEMA: &str = "dwg-inspection/1";
const MAX_SAMPLE_CHARS: usize = 160;

#[derive(Debug, Clone)]
pub struct InspectOptions {
    pub include_input_name: bool,
    pub notification_samples: usize,
    pub text_samples: usize,
}

impl Default for InspectOptions {
    fn default() -> Self {
        Self {
            include_input_name: false,
            notification_samples: 20,
            text_samples: 0,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct InspectionReport {
    pub schema: &'static str,
    pub status: &'static str,
    pub input: InputSummary,
    pub drawing: DrawingSummary,
    pub performance: PerformanceSummary,
    pub entity_types: BTreeMap<String, usize>,
    pub unknown_entities: UnknownEntitySummary,
    pub text: TextSummary,
    pub bounds: Option<Bounds3>,
    pub diagnostics: DiagnosticSummary,
}

#[derive(Debug, Serialize)]
pub struct InputSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct DrawingSummary {
    pub version: String,
    pub maintenance_version: u8,
    pub entities: usize,
    pub objects: usize,
    pub layers: usize,
    pub text_styles: usize,
    pub blocks: usize,
    pub block_references: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub largest_block: Option<BlockSummary>,
}

#[derive(Debug, Serialize)]
pub struct BlockSummary {
    pub name: String,
    pub entity_handles: usize,
    pub references: usize,
}

#[derive(Debug, Serialize)]
pub struct PerformanceSummary {
    pub parse_ms: u64,
    pub analysis_ms: u64,
    pub total_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_rss_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct UnknownEntitySummary {
    pub count: usize,
    pub by_name: BTreeMap<String, usize>,
}

#[derive(Debug, Default, Serialize)]
pub struct TextSummary {
    pub entities: usize,
    pub hangul_entities: usize,
    pub hangul_characters: usize,
    pub question_marks: usize,
    pub replacement_characters: usize,
    pub null_characters: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub samples: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bounds3 {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Serialize)]
pub struct DiagnosticSummary {
    pub count: usize,
    pub by_type: BTreeMap<String, usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub samples: Vec<DiagnosticSample>,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticSample {
    pub kind: String,
    pub message: String,
}

pub fn inspect_dwg(path: &Path, options: &InspectOptions) -> Result<InspectionReport> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("cannot read input metadata: {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("input is not a file: {}", path.display());
    }

    let started = Instant::now();
    let document = engine::parse_acadrust(path)?;
    let parse_elapsed = started.elapsed();

    let analysis_started = Instant::now();
    let mut entity_types = BTreeMap::new();
    let mut unknown_by_name = BTreeMap::new();
    let mut text = TextSummary::default();
    let mut bounds = BoundsAccumulator::default();
    let mut block_references = 0;

    for entity in document.entities() {
        let entity_name = entity.as_entity().entity_type().to_owned();
        *entity_types.entry(entity_name).or_insert(0) += 1;

        match entity {
            EntityType::Unknown(unknown) => {
                *unknown_by_name.entry(unknown.dxf_name.clone()).or_insert(0) += 1;
            }
            EntityType::Insert(_) => {
                block_references += 1;
                bounds.include_entity(entity);
            }
            EntityType::Text(value) => {
                text.include(&value.value, options.text_samples);
                bounds.include_entity(entity);
            }
            EntityType::MText(value) => {
                text.include(&value.value, options.text_samples);
                bounds.include_entity(entity);
            }
            EntityType::AttributeEntity(value) => {
                text.include(&value.value, options.text_samples);
                bounds.include_entity(entity);
            }
            EntityType::AttributeDefinition(value) => {
                text.include(&value.default_value, options.text_samples);
                bounds.include_entity(entity);
            }
            EntityType::Ray(_) | EntityType::XLine(_) => {
                // Infinite construction geometry must not dominate drawing extents.
            }
            _ => bounds.include_entity(entity),
        }
    }

    let largest_block = document
        .block_records
        .iter()
        .max_by_key(|block| block.entity_handles.len())
        .map(|block| BlockSummary {
            name: block.name.clone(),
            entity_handles: block.entity_handles.len(),
            references: block.insert_handles.len(),
        });

    let mut diagnostic_types = BTreeMap::new();
    let mut diagnostic_samples = Vec::new();
    for diagnostic in document.notifications.iter() {
        let kind = diagnostic.notification_type.to_string();
        *diagnostic_types.entry(kind.clone()).or_insert(0) += 1;
        if diagnostic_samples.len() < options.notification_samples {
            diagnostic_samples.push(DiagnosticSample {
                kind,
                message: truncate_sample(&diagnostic.message),
            });
        }
    }

    let analysis_elapsed = analysis_started.elapsed();
    let total_elapsed = started.elapsed();
    let unknown_count = unknown_by_name.values().sum();

    Ok(InspectionReport {
        schema: REPORT_SCHEMA,
        status: "ok",
        input: InputSummary {
            name: options.include_input_name.then(|| {
                path.file_name()
                    .unwrap_or(path.as_os_str())
                    .to_string_lossy()
                    .into_owned()
            }),
            size_bytes: metadata.len(),
        },
        drawing: DrawingSummary {
            version: document.version.to_string(),
            maintenance_version: document.maintenance_version,
            entities: document.entity_count(),
            objects: document.objects.len(),
            layers: document.layers.len(),
            text_styles: document.text_styles.len(),
            blocks: document.block_records.len(),
            block_references,
            largest_block,
        },
        performance: PerformanceSummary {
            parse_ms: duration_ms(parse_elapsed),
            analysis_ms: duration_ms(analysis_elapsed),
            total_ms: duration_ms(total_elapsed),
            peak_rss_bytes: peak_rss_bytes(),
        },
        entity_types,
        unknown_entities: UnknownEntitySummary {
            count: unknown_count,
            by_name: unknown_by_name,
        },
        text,
        bounds: bounds.finish(),
        diagnostics: DiagnosticSummary {
            count: document.notifications.len(),
            by_type: diagnostic_types,
            samples: diagnostic_samples,
        },
    })
}

impl TextSummary {
    fn include(&mut self, value: &str, sample_limit: usize) {
        self.entities += 1;

        let hangul_characters = value
            .chars()
            .filter(|character| is_hangul(*character))
            .count();
        if hangul_characters > 0 {
            self.hangul_entities += 1;
            self.hangul_characters += hangul_characters;
            if self.samples.len() < sample_limit {
                self.samples.push(truncate_sample(value));
            }
        }

        self.question_marks += value.chars().filter(|character| *character == '?').count();
        self.replacement_characters += value
            .chars()
            .filter(|character| *character == '\u{fffd}')
            .count();
        self.null_characters += value.chars().filter(|character| *character == '\0').count();
    }
}

#[derive(Debug)]
pub(crate) struct BoundsAccumulator {
    min: [f64; 3],
    max: [f64; 3],
    has_value: bool,
}

impl Default for BoundsAccumulator {
    fn default() -> Self {
        Self {
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
            has_value: false,
        }
    }
}

impl BoundsAccumulator {
    pub(crate) fn include_entity(&mut self, entity: &EntityType) {
        let value = entity.as_entity().bounding_box();
        let min = [value.min.x, value.min.y, value.min.z];
        let max = [value.max.x, value.max.y, value.max.z];
        if min
            .iter()
            .chain(max.iter())
            .any(|component| !component.is_finite())
            || min.iter().zip(max.iter()).any(|(min, max)| min > max)
        {
            return;
        }

        for index in 0..3 {
            self.min[index] = self.min[index].min(min[index]);
            self.max[index] = self.max[index].max(max[index]);
        }
        self.has_value = true;
    }

    pub(crate) fn finish(self) -> Option<Bounds3> {
        self.has_value.then_some(Bounds3 {
            min: self.min,
            max: self.max,
        })
    }
}

fn is_hangul(character: char) -> bool {
    matches!(
        character as u32,
        0x1100..=0x11ff
            | 0x3130..=0x318f
            | 0xa960..=0xa97f
            | 0xac00..=0xd7a3
            | 0xd7b0..=0xd7ff
    )
}

fn truncate_sample(value: &str) -> String {
    let mut characters = value.chars();
    let mut result: String = characters.by_ref().take(MAX_SAMPLE_CHARS).collect();
    if characters.next().is_some() {
        result.push('…');
    }
    result
}

pub(crate) fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(unix)]
pub(crate) fn peak_rss_bytes() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage initializes the provided rusage structure on success.
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    // SAFETY: result == 0 guarantees that usage has been initialized.
    let usage = unsafe { usage.assume_init() };
    let value = u64::try_from(usage.ru_maxrss).ok()?;
    #[cfg(target_os = "macos")]
    {
        Some(value)
    }
    #[cfg(not(target_os = "macos"))]
    {
        value.checked_mul(1024)
    }
}

#[cfg(windows)]
pub(crate) fn peak_rss_bytes() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters = std::mem::MaybeUninit::<PROCESS_MEMORY_COUNTERS>::zeroed();
    // SAFETY: the current-process pseudo handle is always valid and the size
    // matches PROCESS_MEMORY_COUNTERS.
    let result = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            counters.as_mut_ptr(),
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if result == 0 {
        return None;
    }
    // SAFETY: a non-zero result guarantees initialized counters.
    let counters = unsafe { counters.assume_init() };
    Some(counters.PeakWorkingSetSize as u64)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn peak_rss_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_metrics_count_hangul_and_corruption_markers() {
        let mut summary = TextSummary::default();
        summary.include("102동? \u{fffd}\0", 1);

        assert_eq!(summary.entities, 1);
        assert_eq!(summary.hangul_entities, 1);
        assert_eq!(summary.hangul_characters, 1);
        assert_eq!(summary.question_marks, 1);
        assert_eq!(summary.replacement_characters, 1);
        assert_eq!(summary.null_characters, 1);
        assert_eq!(summary.samples, vec!["102동? \u{fffd}\0"]);
    }

    #[test]
    fn sample_text_is_private_by_default() {
        let options = InspectOptions::default();
        assert!(!options.include_input_name);
        assert_eq!(options.text_samples, 0);
    }

    #[test]
    fn long_samples_are_bounded() {
        let source = "한".repeat(MAX_SAMPLE_CHARS + 1);
        let sample = truncate_sample(&source);
        assert_eq!(sample.chars().count(), MAX_SAMPLE_CHARS + 1);
        assert!(sample.ends_with('…'));
    }
}
