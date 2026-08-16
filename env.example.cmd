@echo off
REM ---------------------------------------------------------------------------
REM Example environment for launching dsh WITH the quant-data MCP bundle.
REM
REM Copy these `set` lines into your dsh launch script (e.g. dsh-web-dual.cmd)
REM BEFORE the line that starts the watchdog / dsh. Then restart dsh.
REM Adjust the paths to your own machine. (Use CRLF + no BOM in the .cmd.)
REM ---------------------------------------------------------------------------

REM ⚠️ 下面的路径只是示例（原作者的机器）。请改成「你自己的」路径后再用：
REM   - QUANT_MCP_NODE 指向你机器上的 node.exe（Node >= 18）
REM   - QUANT_MCP_SERVER 指向你用 setup.ps1 安装后生成的 quant-mcp-server.mjs
REM   - QUANT_MCP_CWD 指向一个存在的目录（server 的工作目录）
set "QUANT_MCP_NODE=C:\Users\YOUR_USER\.workbuddy\binaries\node\versions\22.22.2\node.exe"
set "QUANT_MCP_SERVER=C:\Users\YOUR_USER\.dsh\profiles\node_modules\dsh-quant-data-mcp\lib\quant-mcp-server.mjs"
set "QUANT_MCP_CWD=C:\Users\YOUR_USER\quant-workspace"

REM Optional: enable server-side logging (unset = logging disabled)
REM set "QUANT_MCP_LOG=C:\Users\YOUR_USER\dsh-mcp-quant-server.log"
