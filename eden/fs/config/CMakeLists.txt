# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

add_fbthrift_library(
  eden_config_thrift
  eden_config.thrift
  LANGUAGES cpp py
  PY_NAMESPACE facebook.eden.eden_config
)

# thrift-python (mstch_python) codegen for the modern CLI imports
# (eden.fs.config.eden_config.thrift_types).
add_fbthrift_python_library(
  eden_config_thrift_python
  eden_config.thrift
  NAMESPACE eden.fs.config
)

file(GLOB CONFIG_SRCS "*.cpp")
add_library(
  eden_config STATIC
    ${CONFIG_SRCS}
)
target_link_libraries(
  eden_config
  PUBLIC
    Folly::folly
    edencommon::edencommon_os
    edencommon::edencommon_utils
    eden_config_thrift_cpp
    eden_store_type
    eden_model
    eden_utils
    cpptoml
    ${RE2_LIBRARY}
)

if(BUILD_TESTS)

  add_subdirectory(test)

endif()
