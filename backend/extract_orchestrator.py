import os

source_path = r"c:\Users\mohit\Desktop\python\Vertex-swarm\vertex_swarm\backend\original_chat.py"
dest_path = r"c:\Users\mohit\Desktop\python\Vertex-swarm\vertex_swarm\backend\app\orchestrator.py"

with open(source_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

imports = lines[1:33]
helpers = lines[53:293]
run_agent_loop = lines[339:1066]

# Replace inside run_agent_loop
for i in range(len(run_agent_loop)):
    line = run_agent_loop[i]
    if "user.user_id" in line:
        line = line.replace("user.user_id", "user_id")
    if "req.workspace_skeleton" in line:
        line = line.replace("req.workspace_skeleton", "req_workspace_skeleton")
    if "req.request_context" in line:
        line = line.replace("req.request_context", "req_request_context")
    if "req.ide_context_enabled" in line:
        line = line.replace("req.ide_context_enabled", "req_ide_context_enabled")
    run_agent_loop[i] = line

with open(dest_path, "w", encoding="utf-8") as f:
    f.writelines(imports)
    f.write("\n")
    f.writelines(helpers)
    f.write("\n")
    f.writelines(run_agent_loop)

print("Orchestrator successfully written!")
