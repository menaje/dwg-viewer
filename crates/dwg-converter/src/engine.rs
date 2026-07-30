use std::path::Path;

use acadrust::{CadDocument, DwgReader};
use anyhow::{Context, Result};

pub(crate) const ACADRUST_ENGINE_ID: &str = "acadrust";
pub(crate) const ACADRUST_ENGINE_VERSION: &str = "0.4.1";
pub(crate) const ACADRUST_ENGINE_LICENSE: &str = "MPL-2.0";

pub(crate) fn parse_acadrust(path: &Path) -> Result<CadDocument> {
    let mut reader = DwgReader::from_file(path)
        .with_context(|| format!("cannot open DWG: {}", path.display()))?;
    reader
        .read()
        .with_context(|| format!("cannot parse DWG: {}", path.display()))
}
