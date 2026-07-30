# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

if (NOT WIN32)
  file(GLOB OVERLAY_DEV_SRCS "*.cpp")
  add_library(
    eden_fscatalog_dev STATIC
      ${OVERLAY_DEV_SRCS}
  )
  target_link_libraries(
    eden_fscatalog_dev
    PUBLIC
      eden_overlay_thrift_cpp
      eden_fuse
      eden_utils
  )
endif()
