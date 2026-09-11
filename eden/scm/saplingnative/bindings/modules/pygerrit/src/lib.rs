/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

#![allow(non_camel_case_types)]

use std::sync::Arc;

use configmodel::Config;
use cpython::*;
use cpython_ext::PyNone;
use cpython_ext::ResultPyErrExt;
use cpython_ext::convert::ImplInto;
use cpython_ext::convert::Serde;
use gerrit::Change;
use gerrit::Client;

pub fn init_module(py: Python, package: &str) -> PyResult<PyModule> {
    let name = [package, "gerrit"].join(".");
    let m = PyModule::new(py, &name)?;
    m.add(
        py,
        "query",
        py_fn!(py, query(config: ImplInto<Arc<dyn Config>>, spec: String)),
    )?;
    m.add(
        py,
        "change",
        py_fn!(py, change(config: ImplInto<Arc<dyn Config>>, id: String)),
    )?;
    m.add(
        py,
        "stackfor",
        py_fn!(py, stack_for(config: ImplInto<Arc<dyn Config>>, id: String)),
    )?;
    m.add(
        py,
        "changeurl",
        py_fn!(py, change_url(config: ImplInto<Arc<dyn Config>>, number: u64)),
    )?;
    m.add(
        py,
        "review",
        py_fn!(
            py,
            review(
                config: ImplInto<Arc<dyn Config>>,
                change: Serde<Change>,
                input: Serde<serde_json::Value>,
            )
        ),
    )?;
    m.add(
        py,
        "settopic",
        py_fn!(
            py,
            set_topic(
                config: ImplInto<Arc<dyn Config>>,
                change: Serde<Change>,
                topic: String,
            )
        ),
    )?;
    m.add(
        py,
        "addreviewer",
        py_fn!(
            py,
            add_reviewer(
                config: ImplInto<Arc<dyn Config>>,
                change: Serde<Change>,
                reviewer: String,
            )
        ),
    )?;
    Ok(m)
}

fn client(py: Python, config: ImplInto<Arc<dyn Config>>) -> PyResult<Client> {
    Client::from_config(config.into().as_ref()).map_pyerr(py)
}

/// Changes come back as JSON with the derived review state folded in, so
/// Python never has to know how a vote turns into a state.
fn as_json(changes: &[Change]) -> Vec<serde_json::Value> {
    changes.iter().map(Change::to_json).collect()
}

fn query(
    py: Python,
    config: ImplInto<Arc<dyn Config>>,
    spec: String,
) -> PyResult<Serde<Vec<serde_json::Value>>> {
    let client = client(py, config)?;
    let changes = py.allow_threads(|| client.query(&spec)).map_pyerr(py)?;
    Ok(Serde(as_json(&changes)))
}

fn change(
    py: Python,
    config: ImplInto<Arc<dyn Config>>,
    id: String,
) -> PyResult<Serde<Option<serde_json::Value>>> {
    let client = client(py, config)?;
    let change = py.allow_threads(|| client.change(&id)).map_pyerr(py)?;
    Ok(Serde(change.as_ref().map(Change::to_json)))
}

/// A change and the open changes below it, root first.
fn stack_for(
    py: Python,
    config: ImplInto<Arc<dyn Config>>,
    id: String,
) -> PyResult<Serde<Vec<serde_json::Value>>> {
    let client = client(py, config)?;
    let stack = py.allow_threads(|| client.stack_for(&id)).map_pyerr(py)?;
    Ok(Serde(as_json(&stack)))
}

fn change_url(py: Python, config: ImplInto<Arc<dyn Config>>, number: u64) -> PyResult<String> {
    Ok(client(py, config)?.change_url(number))
}

fn review(
    py: Python,
    config: ImplInto<Arc<dyn Config>>,
    change: Serde<Change>,
    input: Serde<serde_json::Value>,
) -> PyResult<PyNone> {
    let client = client(py, config)?;
    py.allow_threads(|| client.review(&change.0, input.0))
        .map_pyerr(py)?;
    Ok(PyNone)
}

fn set_topic(
    py: Python,
    config: ImplInto<Arc<dyn Config>>,
    change: Serde<Change>,
    topic: String,
) -> PyResult<PyNone> {
    let client = client(py, config)?;
    py.allow_threads(|| client.set_topic(&change.0, &topic))
        .map_pyerr(py)?;
    Ok(PyNone)
}

fn add_reviewer(
    py: Python,
    config: ImplInto<Arc<dyn Config>>,
    change: Serde<Change>,
    reviewer: String,
) -> PyResult<PyNone> {
    let client = client(py, config)?;
    py.allow_threads(|| client.add_reviewer(&change.0, &reviewer))
        .map_pyerr(py)?;
    Ok(PyNone)
}
