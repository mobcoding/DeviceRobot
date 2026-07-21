import { spawn } from "node:child_process";

export interface AiSecretProtector {
  protect(secret: string): Promise<string>;
  reveal(protectedSecret: string): Promise<string>;
}

export class AiSecretProtectionError extends Error {}

const protectScript = [
  "$plain = [Console]::In.ReadToEnd()",
  "if ([string]::IsNullOrWhiteSpace($plain)) { exit 2 }",
  "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
  "$protected = ConvertFrom-SecureString -SecureString $secure",
  "[Console]::Out.Write($protected)",
].join("; ");

const revealScript = [
  "$protected = [Console]::In.ReadToEnd()",
  "if ([string]::IsNullOrWhiteSpace($protected)) { exit 2 }",
  "$secure = ConvertTo-SecureString -String $protected",
  "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
].join("; ");

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    process.once("error", () =>
      reject(new AiSecretProtectionError("无法使用 Windows 凭据保护服务。")),
    );
    process.once("close", (code) => {
      if (code === 0) {
        const output = Buffer.concat(stdout).toString("utf8").trim();
        if (output.length > 0) {
          resolve(output);
          return;
        }
      }
      void stderr;
      reject(new AiSecretProtectionError("无法使用 Windows 凭据保护服务。"));
    });
    process.stdin.end(input, "utf8");
  });
}

export class WindowsDpapiSecretProtector implements AiSecretProtector {
  public async protect(secret: string): Promise<string> {
    return await runPowerShell(protectScript, secret);
  }

  public async reveal(protectedSecret: string): Promise<string> {
    return await runPowerShell(revealScript, protectedSecret);
  }
}
