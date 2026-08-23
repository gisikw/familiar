//! Familiar-owned chrome model.
//!
//! The sidebar is not a workspace/navigation tree: it reserves the top region
//! for the Familiar mark and the remaining rows for a simple enumerated list of
//! subagent jobs fetched from `GET /v1/jobs`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobRow {
    pub ordinal: usize,
    pub id: String,
    pub label: String,
    pub state: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SidebarModel {
    pub jobs: Vec<JobRow>,
}
