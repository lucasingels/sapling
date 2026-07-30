# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

rust_static_library(rust_backtrace_ffi CRATE backtrace_ffi PACKAGE backtrace-ffi USE_CXX_INCLUDE)

rust_cxx_bridge(
  backtrace_ffi
  "src/lib.rs"
  LIBS
  Folly::folly
)

target_link_libraries(
  backtrace_ffi
  PUBLIC
  rust_backtrace_ffi
  Folly::folly
)
