use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use dwg_converter::{inspect_dwg, InspectOptions};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(
    name = "dwg-converter",
    version,
    about = "Inspect DWG files and prepare packed scene data"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Parse a DWG and emit a privacy-conscious JSON report.
    Inspect {
        /// Input DWG path.
        input: PathBuf,

        /// Also write the JSON report to this path.
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Format JSON for human reading.
        #[arg(long)]
        pretty: bool,

        /// Include the source file name in the report.
        #[arg(long)]
        include_input_name: bool,

        /// Include up to this many Hangul text samples. Defaults to zero.
        #[arg(long, default_value_t = 0)]
        text_samples: usize,

        /// Include up to this many parser diagnostic samples.
        #[arg(long, default_value_t = 20)]
        notification_samples: usize,
    },
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
                schema: "dwg-inspection/1",
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
        Command::Inspect {
            input,
            output,
            pretty,
            include_input_name,
            text_samples,
            notification_samples,
        } => {
            let options = InspectOptions {
                include_input_name,
                notification_samples,
                text_samples,
            };
            let report = inspect_dwg(&input, &options)?;
            let json = if pretty {
                serde_json::to_string_pretty(&report)
            } else {
                serde_json::to_string(&report)
            }
            .context("cannot serialize inspection report")?;

            if let Some(output_path) = output {
                std::fs::write(&output_path, json.as_bytes())
                    .with_context(|| format!("cannot write report: {}", output_path.display()))?;
            }
            println!("{json}");
        }
    }
    Ok(())
}
