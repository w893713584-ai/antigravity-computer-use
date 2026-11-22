#ifndef CUA_SEATBELT_H
#define CUA_SEATBELT_H

#include <JavaScriptCore/JavaScriptCore.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void cua_close_extra_fds(void);
bool cua_install_rlimits(uint64_t cpu_soft_sec, uint64_t cpu_hard_sec, int *err_out);
bool cua_enter_seatbelt(const char *profile_utf8, char *err_buf, size_t err_buf_len);
double cua_process_cpu_seconds(void);

bool cua_jsc_spi_available(void);
void cua_jsc_set_cpu_limit(JSContextGroupRef group, double seconds);
void cua_jsc_clear_cpu_limit(JSContextGroupRef group);
void cua_jsc_set_eval_enabled(JSGlobalContextRef ctx, bool enabled, JSStringRef message);

bool cua_probe_denials(
    const char *home_probe_path,
    const char *tmp_write_path,
    const char *uds_probe_path,
    char *out_json,
    size_t out_json_len
);

#ifdef __cplusplus
}
#endif

#endif
