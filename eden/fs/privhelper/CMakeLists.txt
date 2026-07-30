# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

# priority/ sources are platform-guarded internally (#ifdef __linux__/__APPLE__)
file(GLOB PRIVHELPER_SRCS "*.cpp" "priority/*.cpp")

add_library(
  eden_fuse_privhelper STATIC
    ${PRIVHELPER_SRCS}
)

target_link_libraries(
  eden_fuse_privhelper
  PUBLIC
    eden_utils
    Folly::folly
  PRIVATE
    eden_nfs_xdr
)

if (APPLE)
  target_link_libraries(
    eden_fuse_privhelper
    PUBLIC
      "-framework CoreFoundation"
      "-framework IOKit"
  )
endif()

if (SELINUX_INCLUDE_DIR)
  target_include_directories(
    eden_fuse_privhelper
    PRIVATE
      ${SELINUX_INCLUDE_DIR}
  )
  target_link_libraries(
    eden_fuse_privhelper
    PUBLIC
      ${SELINUX_LIBRARIES}
  )
endif()

if(NOT WIN32)
  if(BUILD_TESTS)
    add_subdirectory(test)
  endif()
endif()
