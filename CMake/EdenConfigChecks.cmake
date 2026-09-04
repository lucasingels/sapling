# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

include(FindPkgConfig)

set(CMAKE_THREAD_PREFER_PTHREAD ON)
set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)

find_package(gflags CONFIG REQUIRED)
include_directories(${GFLAGS_INCLUDE_DIR})

find_package(Glog REQUIRED)
include_directories(${GLOG_INCLUDE_DIR})

# We need to probe for libevent because the current stable version
# of libevent doesn't publish the -L libdir in its exported interface
# which means that folly simply exports `event` to us, leaving us
# unable to resolve and link it.  Pulling in the package via its
# config causes the event target to be defined and satisfies the
# linker.
find_package(Libevent CONFIG QUIET)

find_package(fmt CONFIG REQUIRED)
find_package(folly CONFIG REQUIRED)
include_directories(${FOLLY_INCLUDE_DIR})

find_package(fb303 CONFIG REQUIRED)
include_directories(${FB303_INCLUDE_DIR})

find_package(fizz CONFIG REQUIRED)
include_directories(${FIZZ_INCLUDE_DIR})

find_package(wangle CONFIG REQUIRED)
include_directories(${WANGLE_INCLUDE_DIR})

find_package(FBThrift CONFIG REQUIRED COMPONENTS cpp2 py)
include_directories(${FBTHRIFT_INCLUDE_DIR})

find_package(GMock MODULE REQUIRED)
include_directories(${GMOCK_INCLUDEDIR} ${LIBGMOCK_INCLUDE_DIR})
include(GoogleTest)
enable_testing()

find_package(OpenSSL MODULE REQUIRED)

find_package(SELinux)
set(EDEN_HAVE_SELINUX ${SELINUX_FOUND})

if("${ENABLE_GIT}" STREQUAL "AUTO")
  find_package(LibGit2 MODULE)
  set(EDEN_HAVE_GIT "${LibGit2_FOUND}")
elseif(ENABLE_GIT)
  find_package(LibGit2 MODULE REQUIRED)
  set(EDEN_HAVE_GIT "${LibGit2_FOUND}")
else()
  set(EDEN_HAVE_GIT OFF)
endif()

find_package(Re2 MODULE REQUIRED)
include_directories(${RE2_INCLUDE_DIR})

# re2's public headers include abseil headers. When re2 comes from a package
# manager (e.g. a keg-only Homebrew re2), its abseil dependency lives in a
# prefix the compiler does not search by default and no imported target adds.
# Only the abseil keg may be added here: the general Homebrew include dir
# (/opt/homebrew/include) also holds folly/glog headers that would shadow the
# getdeps-built ones, since -I dirs are searched before -isystem dirs.
find_path(ABSL_INCLUDE_DIR NAMES absl/base/call_once.h
          PATHS /opt/homebrew/opt/abseil/include /usr/local/opt/abseil/include
          NO_DEFAULT_PATH)
if(ABSL_INCLUDE_DIR)
  include_directories(${ABSL_INCLUDE_DIR})
endif()

# BUCK exports eden/scm/lib/backingstore's include/SaplingBackingStoreError.h
# under the path eden/scm/lib/backingstore/SaplingBackingStoreError.h (see the
# headers map in its BUCK file), and eden/fs/utils/EdenError.h includes it by
# that name. Mirror the BUCK header layout with a forwarding shim — it must
# not be a copy, since #pragma once dedupes by file identity and TUs that
# also include the real header via ffi.h would see a redefinition.
file(GENERATE
  OUTPUT "${CMAKE_BINARY_DIR}/buck-hdrs/eden/scm/lib/backingstore/SaplingBackingStoreError.h"
  CONTENT "#pragma once\n#include \"eden/scm/lib/backingstore/include/SaplingBackingStoreError.h\"\n")
include_directories("${CMAKE_BINARY_DIR}/buck-hdrs")

find_package(edencommon CONFIG REQUIRED)

# The following packages ship with their own CMake configuration files
find_package(cpptoml CONFIG REQUIRED)
# Some test targets include eden/fs/config headers (which pull in cpptoml.h)
# without linking the cpptoml target; on Linux the header sits in /usr/include
# but a Homebrew keg is invisible to them. Surface the include dir globally.
get_target_property(CPPTOML_INTERFACE_INCLUDES cpptoml INTERFACE_INCLUDE_DIRECTORIES)
if(CPPTOML_INTERFACE_INCLUDES)
  include_directories(${CPPTOML_INTERFACE_INCLUDES})
endif()
find_package(gflags CONFIG REQUIRED)

find_package(BLAKE3 REQUIRED CONFIG)
include_directories(${BLAKE3_INCLUDE_DIR})

# TODO: It shouldn't be too hard to turn sqlite3 into optional
# dependencies, since we have alternate LocalStore implementations.
find_package(Sqlite3 REQUIRED)
set(EDEN_HAVE_SQLITE3 ${SQLITE3_FOUND})
if (NOT WIN32)
  find_package(LMDB REQUIRED)
  set(EDEN_HAVE_LMDB ${LMDB_FOUND})
  include_directories(${LMDB_INCLUDE_DIR})
endif()

find_package(python-toml REQUIRED)
find_package(python-filelock REQUIRED)
find_package(python-psutil REQUIRED)

# pexpect is used by some of the integration tests.
# If we don't find it we simply won't run those tests.
find_package(pexpect)

if (NOT WIN32)
  find_package(CURL REQUIRED)
endif()

if (WIN32)
  find_package(Prjfs MODULE REQUIRED)
endif()

if (
    "${CMAKE_SYSTEM_NAME}" STREQUAL "Linux" AND
    EXISTS "${CMAKE_SOURCE_DIR}/eden/fs/service/facebook/CMakeLists.txt"
)
  set(EDEN_HAVE_USAGE_SERVICE ON)
else()
  set(EDEN_HAVE_USAGE_SERVICE OFF)
endif()

if (WIN32)
  set(DEFAULT_ETC_EDEN_DIR "C:/ProgramData/Facebook/eden")
else()
  set(DEFAULT_ETC_EDEN_DIR "/etc/eden")
endif()
set(
  ETC_EDEN_DIR "${DEFAULT_ETC_EDEN_DIR}" CACHE STRING
  "The directory for system-wide EdenFS configuration files."
)
