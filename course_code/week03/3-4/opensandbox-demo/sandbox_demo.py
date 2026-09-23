import asyncio
import json
import os
import sys
from datetime import timedelta
from pathlib import Path

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig
from opensandbox.models import WriteEntry


async def main():
    # 这份标记只创建在宿主工作区，不挂载进容器。
    marker = Path("host-only-marker.txt").resolve()
    marker.write_text("host-original", encoding="utf-8")
    connection = ConnectionConfig(
        domain="127.0.0.1:8080",
        protocol="http",
        # api_key=os.environ["OPEN_SANDBOX_API_KEY"],
        api_key="your-secret-api-key",
        # macOS 上 Docker Desktop 的 bridge 网络对宿主机不可路由，
        # server 代理模式会拿容器内网 IP 去连 execd 而超时；这里走宿主机映射端口。
        use_server_proxy=False,
    )
    sandbox = await Sandbox.create(
        "python:3.11-slim",
        connection_config=connection,
        entrypoint=["tail", "-f", "/dev/null"],
        timeout=timedelta(minutes=3),
        resource={"cpu": "1", "memory": "512Mi"},
    )
    print(f"CREATED: {sandbox.id}", flush=True)

    async with sandbox:
        try:
            # 固定测试样例，不拼接模型生成的 Shell。
            program = "\n".join([
                "import json, pathlib, subprocess, sys",
                "test = 'def allowed(active): return active is True\\n'",
                "test += 'assert allowed(True)\\nassert not allowed(False)\\n'",
                "run = subprocess.run([sys.executable, '-c', test],",
                "    capture_output=True, text=True, timeout=10)",
                f"host_visible = pathlib.Path({str(marker)!r}).exists()",
                "data = {'exit_code': run.returncode,",
                "        'stderr': run.stderr, 'host_visible': host_visible}",
                "pathlib.Path('/tmp/result.json').write_text(json.dumps(data))",
                "print('container test finished')",
            ])
            await sandbox.files.write_files([
                WriteEntry(path="/tmp/check_login.py", data=program, mode=644)
            ])
            execution = await sandbox.commands.run("python /tmp/check_login.py")
            for item in execution.logs.stdout:
                print(item.text)
            for item in execution.logs.stderr:
                print(item.text, file=sys.stderr)

            result = json.loads(await sandbox.files.read_file("/tmp/result.json"))
            if result["exit_code"] != 0:
                raise RuntimeError(f"test failed: {result['stderr']}")
            if result["host_visible"]:
                raise RuntimeError("unexpected host marker visible")
            if marker.read_text(encoding="utf-8") != "host-original":
                raise RuntimeError("host marker changed")
            Path("sandbox-result.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print("VERIFIED: test passed; host marker absent in container")
        finally:
            # 退出客户端上下文不代替销毁容器，显式发起清理。
            await sandbox.kill()
            print(f"DESTROYED: {sandbox.id}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"DEMO FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
