# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

add_fbthrift_library(
  eden_service_thrift
  eden.thrift
  LANGUAGES cpp py
  PY_NAMESPACE facebook.eden
  SERVICES
    EdenService
  DEPENDS
    eden_config_thrift
    fb303::fb303_thrift
)
add_fbthrift_library(
  streamingeden_thrift
  streamingeden.thrift
  LANGUAGES cpp
  SERVICES
    StreamingEdenService
  DEPENDS
    eden_service_thrift
)

# thrift-python (mstch_python) codegen for the modern CLI imports
# (eden.fs.service.eden.thrift_types / thrift_clients). eden.thrift includes
# fb303_core.thrift, whose python module must exist too; its thrift file
# comes from the installed fb303 dependency.
find_path(FB303_THRIFT_INCLUDE_DIR
  NAMES fb303/thrift/fb303_core.thrift
  PATH_SUFFIXES include/thrift-files
)
if(FB303_THRIFT_INCLUDE_DIR)
  add_fbthrift_python_library(
    fb303_core_thrift_python
    "${FB303_THRIFT_INCLUDE_DIR}/fb303/thrift/fb303_core.thrift"
    SERVICES BaseService
    EXTRA_INCLUDE_DIRS "${FB303_THRIFT_INCLUDE_DIR}"
  )
  add_fbthrift_python_library(
    eden_service_thrift_python
    eden.thrift
    NAMESPACE eden.fs.service
    SERVICES EdenService
    DEPENDS
      eden_config_thrift_python
      fb303_core_thrift_python
    EXTRA_INCLUDE_DIRS "${FB303_THRIFT_INCLUDE_DIR}"
  )
endif()

file(GLOB SERVICE_SRCS "*.cpp")

# A couple utility files our split out into a separate lower-level library
# This also effectively includes ThriftUtil.h, which has no corresponding .cpp
# file.
# TODO: In the future it would perhaps be nicer to move these to a separate
# eden/fs/thrift/ subdirectory, perhaps along with eden.thrift too.
list(
  REMOVE_ITEM SERVICE_SRCS
  ${CMAKE_CURRENT_SOURCE_DIR}/PrettyPrinters.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/PrivHelperMain.cpp
)
# PrettyPrinters is header-only: PrettyPrinters.cpp was deleted in "avoid
# allocation in PrettyPrinter formatters", and BUCK agrees (cpp_library
# "pretty_printers" declares headers with no srcs). ThriftUtil.cpp, despite this
# target's name, is already compiled into eden_service via the SERVICE_SRCS glob.
add_library(eden_service_thrift_util INTERFACE)
target_link_libraries(
  eden_service_thrift_util
  INTERFACE
    eden_model
    Folly::folly
)

list(APPEND EDEN_STORE_IMPLEMENTATIONS eden_store_hg)

if(EDEN_HAVE_GIT)
  list(APPEND EDEN_STORE_IMPLEMENTATIONS eden_store_git)
endif()

add_library(
  eden_service STATIC
  ${SERVICE_SRCS}
)
target_link_libraries(
  eden_service
  PUBLIC
    eden_service_thrift_util
    streamingeden_thrift_cpp
    eden_build_config
    eden_config
    eden_fuse_privhelper
    eden_inodes
    eden_model
    eden_nfs_server
    eden_store
    eden_takeover
    eden_telemetry
    ${EDEN_STORE_IMPLEMENTATIONS}
    ${YARPL_LIBRARIES}
    Folly::folly
    cpptoml
    edencommon::edencommon_utils
)

if (EDEN_HAVE_RUST_THRIFT_CLIENTS)
  target_link_libraries(eden_service PUBLIC redirect_ffi)
  target_compile_definitions(eden_service PUBLIC EDEN_HAVE_REDIRECT_FFI)
endif()

if (NOT WIN32)
  target_link_libraries(
    eden_service
    PUBLIC
      eden_fuse
      eden_notifications
  )
endif()

if(EDEN_HAVE_USAGE_SERVICE)
  add_subdirectory(facebook)
  target_link_libraries(
    eden_service
    PUBLIC
      eden_smartplatform_service
  )
endif()
