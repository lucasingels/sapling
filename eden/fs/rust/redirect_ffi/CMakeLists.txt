# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

rust_static_library(rust_redirect_ffi CRATE redirect_ffi PACKAGE redirect-ffi USE_CXX_INCLUDE)

rust_cxx_bridge(
  redirect_ffi
  "src/lib.rs"
  LIBS
  Folly::folly
)

file(GLOB C_API_SRCS "src/*.cpp")
file(GLOB C_API_HDRS "include/*.h")
target_sources(
  redirect_ffi
  PRIVATE
  "${C_API_SRCS}"
)

set_target_properties(
  redirect_ffi
  PROPERTIES
  PUBLIC_HEADER
  "${C_API_HDRS}"
)

target_include_directories(
  redirect_ffi
  PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)

# include/ffi.h uses the eden.thrift generated types (Redirection etc.)
target_link_libraries(
  redirect_ffi
  PUBLIC
  rust_redirect_ffi
  eden_service_thrift_cpp
  Folly::folly
)
