# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

if (IS_FB_BUILD)
  rust_static_library(
    rust_backingstore
    CRATE backingstore
    PACKAGE sapling-backingstore
    USE_CXX_INCLUDE
    FEATURES fb)
else()
  rust_static_library(rust_backingstore CRATE backingstore PACKAGE sapling-backingstore USE_CXX_INCLUDE)
endif()

install_rust_static_library(
  rust_backingstore
  EXPORT mercurial
  INSTALL_DIR lib
)

rust_cxx_bridge(
  backingstore
  "src/ffi.rs"
  LIBS
  fmt::fmt
  Folly::folly
)

file(GLOB C_API_SRCS "src/*.cpp")
file(GLOB C_API_HDRS "include/*.h")
target_sources(
  backingstore
  PRIVATE
  "${C_API_SRCS}"
)
set_target_properties(
  backingstore
  PROPERTIES
  PUBLIC_HEADER
  "${C_API_HDRS}"
)

target_include_directories(
  backingstore
  PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_link_libraries(
  backingstore
  PUBLIC
  edencommon::edencommon_os
  rust_backingstore
  fmt::fmt
  Folly::folly
)

# curl used in the Rust crate has its own copy of curl compiled and it uses
# Crypt32 and Secur32 on Windows. We need to declare the link dependencies here
# to avoid linker errors.
if (WIN32)
  target_link_libraries(
    backingstore
    PRIVATE
    ntdll
    Crypt32
    Secur32
    Ncrypt
    winhttp
  )
else()
  target_link_libraries(
    backingstore
    PRIVATE
      CURL::libcurl
  )
endif()

# Reqwest links against the security framework.
if (APPLE)
  target_link_libraries(
    backingstore
    PRIVATE
    "-framework Security"
  )

  # CURL::libcurl is CMake's builtin FindCURL module, which just locates
  # libcurl.a/.dylib -- it knows nothing of curl's own dependencies. When
  # curl is built static (as getdeps does), the reqwest crate's linked-in
  # curl symbols need nghttp2 too (curl was built with HTTP/2 support), and
  # unlike Linux's more lenient handling of undefined symbols pulled in from
  # a static archive, macOS's linker requires everything resolved at link
  # time: "ld: symbol(s) not found for architecture arm64" for every
  # nghttp2_* symbol libcurl.a references. No manifests/*/[homebrew] entry
  # exists for nghttp2 (it's always built from source by getdeps), and no
  # CMake target for it exists anywhere in this tree or curl's own (unused
  # here) CMake build, so find it directly via getdeps' CMAKE_PREFIX_PATH.
  find_library(NGHTTP2_LIBRARY NAMES nghttp2 REQUIRED)
  target_link_libraries(
    backingstore
    PRIVATE
    ${NGHTTP2_LIBRARY}
  )
endif()

install(
  TARGETS backingstore
  EXPORT mercurial
  LIBRARY DESTINATION lib
  PUBLIC_HEADER DESTINATION eden/scm/lib/backingstore/include
)

if(APPLE)
  # The "git" constructors feature vendors libgit2 into the Rust crate, and
  # libgit2's path code (fs_path.c) calls iconv_open/iconv/iconv_close for
  # filename normalization on macOS.
  target_link_libraries(backingstore PUBLIC iconv)
endif()
