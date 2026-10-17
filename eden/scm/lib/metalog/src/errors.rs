/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

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

impl ForeignError for anyhow::Error {}
impl ForeignError for indexedlog::Error {
    fn permission_error(&self) -> Option<(PathBuf, io::Error)> {
        indexedlog::Error::permission_error(self).map(to_owned_permission_error)
    }
}
impl ForeignError for mincode::Error {}
impl ForeignError for std::io::Error {}
impl ForeignError for std::str::Utf8Error {}
impl ForeignError for std::num::ParseIntError {}
impl ForeignError for zstore::Error {
    fn permission_error(&self) -> Option<(PathBuf, io::Error)> {
        zstore::Error::permission_error(self).map(to_owned_permission_error)
    }
}
impl ForeignError for types::hash::LengthMismatchError {}
impl ForeignError for String {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn test_permission_error_from_read_only_metalog() {
        use std::os::unix::fs::PermissionsExt;

        fn set_read_only(path: &Path, read_only: bool) {
            let dir_mode = if read_only { 0o555 } else { 0o755 };
            let file_mode = if read_only { 0o444 } else { 0o644 };
            for entry in std::fs::read_dir(path).unwrap() {
                let entry = entry.unwrap().path();
                let file_type = entry.symlink_metadata().unwrap().file_type();
                if file_type.is_symlink() {
                    continue;
                } else if file_type.is_dir() {
                    set_read_only(&entry, read_only);
                } else {
                    let perm = std::fs::Permissions::from_mode(file_mode);
                    std::fs::set_permissions(&entry, perm).unwrap();
                }
            }
            let perm = std::fs::Permissions::from_mode(dir_mode);
            std::fs::set_permissions(path, perm).unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("metalog");
        drop(crate::MetaLog::open(&path, None).unwrap());

        set_read_only(&path, true);
        let result = crate::MetaLog::open(&path, None);
        set_read_only(&path, false);

        // root ignores file permissions.
        let Err(err) = result else { return };
        let (err_path, io_err) = err.permission_error().unwrap();
        assert!(err_path.starts_with(&path), "{err_path:?}");
        assert_eq!(io_err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn test_no_permission_error_for_other_errors() {
        let err = Error::new("Root ID is not found".to_string());
        assert!(err.permission_error().is_none());
        let err = Error::from(io::Error::from(io::ErrorKind::PermissionDenied));
        // A bare io::Error has no path, so it is not reported.
        assert!(err.permission_error().is_none());
    }
}
