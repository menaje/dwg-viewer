use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use dwg_converter::benchmark::{
    benchmark_engine, BenchmarkOptions, BenchmarkScope, DEFAULT_MEASURED_RUNS, DEFAULT_WARMUP_RUNS,
};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(
    name = "dwg-converter",
    version,
    about = "Benchmark a process-isolated DWG engine adapter"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Benchmark an external DWG engine adapter.
    Benchmark {
        /// Input DWG path.
        input: PathBuf,

        /// External adapter executable.
        #[arg(long)]
        adapter: PathBuf,

        /// Stable engine identifier for the report.
        #[arg(long, default_value = "libredwg")]
        engine_id: String,

        /// Engine version for the report.
        #[arg(long)]
        engine_version: Option<String>,

        /// SPDX-style engine license identifier for the report.
        #[arg(long)]
        engine_license: Option<String>,

        /// Number of process-isolated measured runs.
        #[arg(long, default_value_t = DEFAULT_MEASURED_RUNS)]
        runs: usize,

        /// Number of process-isolated warmup runs excluded from aggregates.
        #[arg(long, default_value_t = DEFAULT_WARMUP_RUNS)]
        warmup_runs: usize,

        /// Adapter phases to benchmark.
        #[arg(long, value_enum, default_value_t = BenchmarkScopeArg::All)]
        scope: BenchmarkScopeArg,

        /// Also write the benchmark report. Existing files are not overwritten.
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Format JSON for human reading.
        #[arg(long)]
        pretty: bool,

        /// Include the source file name in the report.
        #[arg(long)]
        include_input_name: bool,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BenchmarkScopeArg {
    Inspect,
    Convert,
    All,
}

impl From<BenchmarkScopeArg> for BenchmarkScope {
    fn from(value: BenchmarkScopeArg) -> Self {
        match value {
            BenchmarkScopeArg::Inspect => Self::Inspect,
            BenchmarkScopeArg::Convert => Self::Convert,
            BenchmarkScopeArg::All => Self::All,
        }
    }
}

#[derive(Debug, Serialize)]
struct ErrorReport {
    schema: &'static str,
    status: &'static str,
    error: String,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let report = ErrorReport {
                schema: "dwg-converter-error/1",
                status: "error",
                error: format!("{error:#}"),
            };
            let output = serde_json::to_string_pretty(&report)
                .unwrap_or_else(|_| "{\"status\":\"error\"}".to_owned());
            eprintln!("{output}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Benchmark {
            input,
            adapter,
            engine_id,
            engine_version,
            engine_license,
            runs,
            warmup_runs,
            scope,
            output,
            pretty,
            include_input_name,
        } => {
            if let Some(output_path) = &output {
                preflight_new_report(output_path)?;
            }
            let options = BenchmarkOptions {
                adapter_executable: adapter,
                engine_id,
                engine_version,
                engine_license,
                measured_runs: runs,
                warmup_runs,
                scope: scope.into(),
                include_input_name,
            };

            let report = benchmark_engine(&input, &options)?;
            let json = if pretty {
                serde_json::to_string_pretty(&report)
            } else {
                serde_json::to_string(&report)
            }
            .context("cannot serialize benchmark report")?;
            if let Some(output_path) = output {
                write_new_report(&output_path, json.as_bytes())?;
            }
            println!("{json}");
        }
    }
    Ok(())
}

fn write_new_report(path: &std::path::Path, contents: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| {
            format!(
                "cannot create report (the destination may already exist): {}",
                path.display()
            )
        })?;
    file.write_all(contents)
        .with_context(|| format!("cannot write report: {}", path.display()))
}

fn preflight_new_report(path: &std::path::Path) -> Result<()> {
    match std::fs::metadata(path) {
        Ok(_) => anyhow::bail!("report destination already exists: {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("cannot inspect report destination: {}", path.display()))
        }
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        let metadata = std::fs::metadata(parent)
            .with_context(|| format!("cannot read report directory: {}", parent.display()))?;
        if !metadata.is_dir() {
            anyhow::bail!("report parent is not a directory: {}", parent.display());
        }
    }
    Ok(())
}
