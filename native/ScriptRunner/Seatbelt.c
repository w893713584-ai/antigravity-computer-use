#include "Seatbelt.h"

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sandbox.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef bool (*cua_jsc_terminate_cb_t)(JSContextRef ctx, void *context);
typedef void (*cua_jsc_set_limit_fn_t)(
    JSContextGroupRef group,
    double limit,
    cua_jsc_terminate_cb_t callback,
    void *context
);
typedef void (*cua_jsc_clear_limit_fn_t)(JSContextGroupRef group);
typedef void (*cua_jsc_set_eval_fn_t)(JSGlobalContextRef ctx, bool enabled, JSStringRef message);

static cua_jsc_set_limit_fn_t g_set_limit_fn = NULL;
static cua_jsc_clear_limit_fn_t g_clear_limit_fn = NULL;
static cua_jsc_set_eval_fn_t g_set_eval_fn = NULL;

static bool cua_watchdog_should_terminate(JSContextRef ctx, void *context) {
  (void)ctx;
  (void)context;
  return true;
}

void cua_close_extra_fds(void) {
  struct rlimit rl;
  long max_fd = 1024;
  if (getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur > 3) {
    max_fd = (long)(rl.rlim_cur > 4096 ? 4096 : rl.rlim_cur);
  }
  for (int fd = 3; fd < (int)max_fd; fd++) {
    close(fd);
  }
}

bool cua_install_rlimits(uint64_t cpu_soft_sec, uint64_t cpu_hard_sec, int *err_out) {
  struct rlimit cpu_rl;
  cpu_rl.rlim_cur = (rlim_t)cpu_soft_sec;
  cpu_rl.rlim_max = (rlim_t)cpu_hard_sec;
  if (setrlimit(RLIMIT_CPU, &cpu_rl) != 0) {
    if (err_out) *err_out = errno;
    return false;
  }

  struct rlimit core_rl;
  core_rl.rlim_cur = 0;
  core_rl.rlim_max = 0;
  if (setrlimit(RLIMIT_CORE, &core_rl) != 0) {
    if (err_out) *err_out = errno;
    return false;
  }

  if (err_out) *err_out = 0;
  return true;
}

bool cua_enter_seatbelt(const char *profile_utf8, char *err_buf, size_t err_buf_len) {
  if (!profile_utf8 || !profile_utf8[0]) {
    if (err_buf && err_buf_len > 0) snprintf(err_buf, err_buf_len, "empty seatbelt profile");
    return false;
  }

  char *sb_err = NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  int rc = sandbox_init(profile_utf8, 0, &sb_err);
#pragma clang diagnostic pop

  if (rc != 0) {
    if (err_buf && err_buf_len > 0) {
      snprintf(err_buf, err_buf_len, "%s", sb_err ? sb_err : "sandbox_init failed");
    }
    if (sb_err) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      sandbox_free_error(sb_err);
#pragma clang diagnostic pop
    }
    return false;
  }

  if (sb_err) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    sandbox_free_error(sb_err);
#pragma clang diagnostic pop
  }
  return true;
}

double cua_process_cpu_seconds(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) {
    return 0.0;
  }
  double user_sec = (double)ru.ru_utime.tv_sec + (double)ru.ru_utime.tv_usec / 1000000.0;
  double sys_sec = (double)ru.ru_stime.tv_sec + (double)ru.ru_stime.tv_usec / 1000000.0;
  return user_sec + sys_sec;
}

bool cua_jsc_spi_available(void) {
  if (!g_set_limit_fn) {
    g_set_limit_fn = (cua_jsc_set_limit_fn_t)dlsym(RTLD_DEFAULT, "JSContextGroupSetExecutionTimeLimit");
  }
  if (!g_clear_limit_fn) {
    g_clear_limit_fn = (cua_jsc_clear_limit_fn_t)dlsym(RTLD_DEFAULT, "JSContextGroupClearExecutionTimeLimit");
  }
  if (!g_set_eval_fn) {
    g_set_eval_fn = (cua_jsc_set_eval_fn_t)dlsym(RTLD_DEFAULT, "JSGlobalContextSetEvalEnabled");
  }
  return g_set_limit_fn != NULL && g_clear_limit_fn != NULL && g_set_eval_fn != NULL;
}

void cua_jsc_set_cpu_limit(JSContextGroupRef group, double seconds) {
  if (!g_set_limit_fn) {
    g_set_limit_fn = (cua_jsc_set_limit_fn_t)dlsym(RTLD_DEFAULT, "JSContextGroupSetExecutionTimeLimit");
  }
  if (g_set_limit_fn && group) {
    g_set_limit_fn(group, seconds > 0.0 ? seconds : 0.001, cua_watchdog_should_terminate, NULL);
  }
}

void cua_jsc_clear_cpu_limit(JSContextGroupRef group) {
  if (!g_clear_limit_fn) {
    g_clear_limit_fn = (cua_jsc_clear_limit_fn_t)dlsym(RTLD_DEFAULT, "JSContextGroupClearExecutionTimeLimit");
  }
  if (g_clear_limit_fn && group) {
    g_clear_limit_fn(group);
  }
}

void cua_jsc_set_eval_enabled(JSGlobalContextRef ctx, bool enabled, JSStringRef message) {
  if (!g_set_eval_fn) {
    g_set_eval_fn = (cua_jsc_set_eval_fn_t)dlsym(RTLD_DEFAULT, "JSGlobalContextSetEvalEnabled");
  }
  if (g_set_eval_fn && ctx) {
    g_set_eval_fn(ctx, enabled, message);
  }
}

static bool is_perm_denied_errno(int e) {
  return e == EPERM || e == EACCES;
}

bool cua_probe_denials(
    const char *home_probe_path,
    const char *tmp_write_path,
    const char *uds_probe_path,
    char *out_json,
    size_t out_json_len
) {
  const char *home_target = (home_probe_path && home_probe_path[0]) ? home_probe_path : getenv("HOME");
  if (!home_target || !home_target[0]) home_target = "/Users";
  const char *tmp_target = (tmp_write_path && tmp_write_path[0]) ? tmp_write_path : "/private/tmp/cua-sb-write-probe.tmp";
  const char *uds_target = (uds_probe_path && uds_probe_path[0]) ? uds_probe_path : "/private/tmp/cua-sb-uds-probe.sock";

  // 1. $HOME read probe
  int home_err = 0;
  int home_fd = open(home_target, O_RDONLY);
  if (home_fd >= 0) {
    close(home_fd);
  } else {
    home_err = errno;
  }
  bool home_denied = (home_fd < 0) && is_perm_denied_errno(home_err);

  // 2. /tmp write probe
  int tmp_err = 0;
  int tmp_fd = open(tmp_target, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (tmp_fd >= 0) {
    close(tmp_fd);
    unlink(tmp_target);
  } else {
    tmp_err = errno;
  }
  bool tmp_denied = (tmp_fd < 0) && is_perm_denied_errno(tmp_err);

  // 3. Loopback TCP probe
  int tcp_err = 0;
  bool tcp_denied = false;
  int tcp_sock = socket(AF_INET, SOCK_STREAM, 0);
  if (tcp_sock < 0) {
    tcp_err = errno;
    tcp_denied = is_perm_denied_errno(tcp_err);
  } else {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(1);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    int crc = connect(tcp_sock, (struct sockaddr *)&addr, sizeof(addr));
    if (crc < 0) {
      tcp_err = errno;
      tcp_denied = is_perm_denied_errno(tcp_err);
    }
    close(tcp_sock);
  }

  // 4. Unix domain socket probe
  int uds_err = 0;
  bool uds_denied = false;
  int uds_sock = socket(AF_UNIX, SOCK_STREAM, 0);
  if (uds_sock < 0) {
    uds_err = errno;
    uds_denied = is_perm_denied_errno(uds_err);
  } else {
    struct sockaddr_un uaddr;
    memset(&uaddr, 0, sizeof(uaddr));
    uaddr.sun_family = AF_UNIX;
    strncpy(uaddr.sun_path, uds_target, sizeof(uaddr.sun_path) - 1);
    int urc = connect(uds_sock, (struct sockaddr *)&uaddr, sizeof(uaddr));
    if (urc < 0) {
      uds_err = errno;
      uds_denied = is_perm_denied_errno(uds_err);
    }
    close(uds_sock);
  }

  // 5. Subprocess spawn probe
  int spawn_err = 0;
  pid_t child_pid = 0;
  char *spawn_argv[] = {"/usr/bin/true", NULL};
  int spawn_rc = posix_spawn(&child_pid, "/usr/bin/true", NULL, NULL, spawn_argv, environ);
  if (spawn_rc == 0) {
    int st = 0;
    waitpid(child_pid, &st, 0);
  } else {
    spawn_err = spawn_rc;
  }
  bool spawn_denied = (spawn_rc != 0) && is_perm_denied_errno(spawn_err);

  bool all_ok = home_denied && tmp_denied && tcp_denied && uds_denied && spawn_denied;

  if (out_json && out_json_len > 0) {
    snprintf(
        out_json,
        out_json_len,
        "{\"ok\":%s,\"homeRead\":{\"denied\":%s,\"errno\":%d},"
        "\"tmpWrite\":{\"denied\":%s,\"errno\":%d},"
        "\"tcpConnect\":{\"denied\":%s,\"errno\":%d},"
        "\"udsConnect\":{\"denied\":%s,\"errno\":%d},"
        "\"posixSpawn\":{\"denied\":%s,\"errno\":%d}}",
        all_ok ? "true" : "false",
        home_denied ? "true" : "false", home_err,
        tmp_denied ? "true" : "false", tmp_err,
        tcp_denied ? "true" : "false", tcp_err,
        uds_denied ? "true" : "false", uds_err,
        spawn_denied ? "true" : "false", spawn_err
    );
  }
  return all_ok;
}
