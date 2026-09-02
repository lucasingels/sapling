# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

add_fbthrift_library(
  eden_overlay_thrift
  overlay.thrift
  LANGUAGES cpp py
  PY_NAMESPACE facebook.eden.overlay
)

# thrift-python (mstch_python) codegen for the modern CLI imports
# (facebook.eden.overlay.thrift_types).
add_fbthrift_python_library(
  eden_overlay_thrift_python
  overlay.thrift
  NAMESPACE facebook.eden
)

add_library(
  eden_overlay_checker
  STATIC
  ${CMAKE_CURRENT_SOURCE_DIR}/OverlayChecker.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/OverlayChecker.h
)

if (NOT WIN32)
  target_link_libraries(
    eden_overlay_checker
    PRIVATE
      eden_fscatalog
  )
endif()
