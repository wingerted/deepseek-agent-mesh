#ifndef AGENT_MESH_MOBILE_H
#define AGENT_MESH_MOBILE_H

#include <stdint.h>

char *agent_mesh_mobile_start(const char *config_json);
char *agent_mesh_mobile_call(uint64_t handle, const char *method, const char *params_json);
char *agent_mesh_mobile_stop(uint64_t handle);
void agent_mesh_mobile_string_free(char *value);

#endif
