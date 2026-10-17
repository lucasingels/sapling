/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Minimalistic error handling that just converts all errors to strings.
//
// The error type implements `std::error::Error` so it does not enforce
// callsites to use a particular library like failure or anyhow.

use std::fmt;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug)]
pub struct Error(
    pub(crate) String,
    // Set when the error was caused by a permission failure on this path.
    pub(crate) Option<(PathBuf, io::Error)>,
);

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for Error {}

impl Error {
    pub(crate) fn new(message: String) -> Self {
        Error(message, None)
    }

    /// Find a filesystem operation that failed because the process may not
    /// access or write a path (EACCES, EPERM or EROFS). Returns the path and
    /// the original `io::Error`. See `indexedlog::Error::permission_error`.
    pub fn permission_error(&self) -> Option<(&Path, &io::Error)> {
        self.1.as_ref().map(|(path, err)| (path.as_path(), err))
    }
}

pub trait ForeignError: ToString {
    /// See [`Error::permission_error`].
    fn permission_error(&self) -> Option<(PathBuf, io::Error)> {
        None
    }
}

fn to_owned_permission_error((path, err): (&Path, &io::Error)) -> (PathBuf, io::Error) {
    // io::Error is not Clone. The errno (or kind) is what matters.
    let err = match err.raw_os_error() {
        Some(errno) => io::Error::from_raw_os_error(errno),
        None => io::Error::from(err.kind()),
    };
    (path.to_path_buf(), err)
}

impl<T: ForeignError> From<T> for Error {
    fn from(err: T) -> Error {
        let permission_error = err.permission_error();
        Error(err.to_string(), permission_error)
    }
}

impl ForeignError for indexedlog::Error {
    fn permission_error(&self) -> Option<(PathBuf, io::Error)> {
        indexedlog::Error::permission_error(self).map(to_owned_permission_error)
    }
}
impl ForeignError for mincode::Error {}
impl ForeignError for std::io::Error {}
