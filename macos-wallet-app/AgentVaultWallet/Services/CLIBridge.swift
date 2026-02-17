import Foundation

/// Bridges the macOS GUI to the AgentVault Node.js CLI.
/// Runs CLI commands as child processes and parses their output.
actor CLIBridge {

    enum CLIError: LocalizedError {
        case nodeNotFound
        case cliNotFound
        case commandFailed(String)
        case parseError(String)
        case timeout

        var errorDescription: String? {
            switch self {
            case .nodeNotFound:
                return "Node.js is not installed. Please install Node.js 18+ from nodejs.org or via Homebrew."
            case .cliNotFound:
                return "AgentVault CLI not found. Run 'npm install' in the AgentVault directory."
            case .commandFailed(let msg):
                return "CLI command failed: \(msg)"
            case .parseError(let msg):
                return "Failed to parse CLI output: \(msg)"
            case .timeout:
                return "Command timed out after 60 seconds."
            }
        }
    }

    /// Cached path to the AgentVault project root
    private var projectRoot: String?

    /// Discover the AgentVault project root directory
    func findProjectRoot() -> String? {
        if let cached = projectRoot { return cached }

        // Check common locations
        let candidates = [
            // Relative to the app bundle
            Bundle.main.bundlePath + "/../../../../",
            // Home directory
            NSHomeDirectory() + "/AgentVault",
            // Common dev paths
            "/usr/local/src/AgentVault",
            NSHomeDirectory() + "/Developer/AgentVault",
            NSHomeDirectory() + "/Projects/AgentVault",
            NSHomeDirectory() + "/Code/AgentVault",
        ]

        for path in candidates {
            let packageJSON = (path as NSString).appendingPathComponent("package.json")
            if FileManager.default.fileExists(atPath: packageJSON) {
                // Verify it's actually AgentVault
                if let data = FileManager.default.contents(atPath: packageJSON),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let name = json["name"] as? String,
                   name.contains("agentvault") {
                    let resolved = (path as NSString).standardizingPath
                    projectRoot = resolved
                    return resolved
                }
            }
        }
        return nil
    }

    /// Set the project root manually (from Settings)
    func setProjectRoot(_ path: String) {
        projectRoot = path
    }

    // MARK: - Environment Checks

    func checkEnvironment() async -> EnvironmentStatus {
        var status = EnvironmentStatus()

        // Check Node.js
        if let result = try? await run("node", args: ["--version"]) {
            status.nodeInstalled = true
            status.nodeVersion = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Check npm
        if let _ = try? await run("npm", args: ["--version"]) {
            status.npmInstalled = true
        }

        // Check AgentVault CLI
        if let root = findProjectRoot() {
            let cliEntry = (root as NSString).appendingPathComponent("cli/index.ts")
            status.agentVaultInstalled = FileManager.default.fileExists(atPath: cliEntry)
            if status.agentVaultInstalled {
                status.agentVaultVersion = "local"
            }
        }

        return status
    }

    // MARK: - Wallet Operations

    /// Generate a new wallet for the given chain
    func generateWallet(chain: Chain, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "generate", "--chain", chain.rawValue.lowercased(), "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: chain)
    }

    /// Import a wallet from a mnemonic phrase
    func importFromMnemonic(chain: Chain, mnemonic: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", chain.rawValue.lowercased(),
                   "--mnemonic", mnemonic, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: chain)
    }

    /// Import a wallet from a private key
    func importFromPrivateKey(chain: Chain, privateKey: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", chain.rawValue.lowercased(),
                   "--private-key", privateKey, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: chain)
    }

    /// Import a wallet from a JWK file (Arweave)
    func importFromJWK(filePath: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", "ar", "--jwk-file", filePath, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: .arweave)
    }

    /// Import from PEM file (ICP)
    func importFromPEM(filePath: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", "icp", "--pem-file", filePath, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: .icp)
    }

    /// Import from keystore JSON (Ethereum)
    func importFromKeystore(filePath: String, password: String, name: String) async throws -> CLIWalletResult {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "import", "--chain", "eth", "--keystore", filePath,
                   "--password", password, "--name", name, "--json"]
        )

        return try parseCLIWalletResult(output, chain: .ethereum)
    }

    /// Get wallet balance
    func getBalance(chain: Chain, address: String) async throws -> String {
        let root = try requireProjectRoot()

        let output = try await runCLI(
            root: root,
            args: ["wallet", "balance", "--chain", chain.rawValue.lowercased(), "--address", address, "--json"]
        )

        if let data = output.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let balance = json["balance"] as? String {
            return balance
        }

        // Fallback: try to extract balance from plain text
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return "0"
    }

    /// Export wallet data
    func exportWallet(walletId: String, format: String, outputPath: String) async throws -> String {
        let root = try requireProjectRoot()

        return try await runCLI(
            root: root,
            args: ["wallet-export", "--id", walletId, "--format", format, "--output", outputPath, "--json"]
        )
    }

    /// Create a backup of all wallets
    func createBackup(outputPath: String, password: String) async throws -> String {
        let root = try requireProjectRoot()

        return try await runCLI(
            root: root,
            args: ["backup", "create", "--output", outputPath, "--password", password, "--json"]
        )
    }

    /// Restore wallets from a backup
    func restoreBackup(inputPath: String, password: String) async throws -> String {
        let root = try requireProjectRoot()

        return try await runCLI(
            root: root,
            args: ["backup", "restore", "--input", inputPath, "--password", password, "--json"]
        )
    }

    // MARK: - Process Execution

    private func requireProjectRoot() throws -> String {
        guard let root = findProjectRoot() else {
            throw CLIError.cliNotFound
        }
        return root
    }

    /// Run the AgentVault CLI via tsx
    private func runCLI(root: String, args: [String]) async throws -> String {
        let tsxPath = (root as NSString).appendingPathComponent("node_modules/.bin/tsx")
        let cliEntry = (root as NSString).appendingPathComponent("cli/index.ts")

        let command: String
        let fullArgs: [String]

        if FileManager.default.fileExists(atPath: tsxPath) {
            command = tsxPath
            fullArgs = [cliEntry] + args
        } else {
            // Fallback: use npx tsx
            command = "npx"
            fullArgs = ["tsx", cliEntry] + args
        }

        return try await run(command, args: fullArgs, cwd: root)
    }

    /// Execute a process and capture its stdout
    @discardableResult
    private func run(_ command: String, args: [String] = [], cwd: String? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let pipe = Pipe()

            // Resolve command path
            if command.hasPrefix("/") || command.hasPrefix(".") {
                process.executableURL = URL(fileURLWithPath: command)
            } else {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = [command] + args
            }

            if process.executableURL?.lastPathComponent != "env" {
                process.arguments = args
            }

            if let cwd = cwd {
                process.currentDirectoryURL = URL(fileURLWithPath: cwd)
            }

            // Inherit PATH from user environment
            var env = ProcessInfo.processInfo.environment
            let additionalPaths = [
                "/usr/local/bin",
                "/opt/homebrew/bin",
                NSHomeDirectory() + "/.nvm/versions/node/current/bin",
                NSHomeDirectory() + "/.volta/bin",
                NSHomeDirectory() + "/.fnm/current/bin",
            ]
            let currentPath = env["PATH"] ?? "/usr/bin:/bin"
            env["PATH"] = (additionalPaths + [currentPath]).joined(separator: ":")
            process.environment = env

            process.standardOutput = pipe
            process.standardError = pipe

            process.terminationHandler = { proc in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""

                if proc.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    continuation.resume(throwing: CLIError.commandFailed(output))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: CLIError.commandFailed(error.localizedDescription))
            }
        }
    }

    // MARK: - Parsing

    private func parseCLIWalletResult(_ output: String, chain: Chain) throws -> CLIWalletResult {
        // Try JSON parse first
        if let data = output.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return CLIWalletResult(
                address: json["address"] as? String ?? "",
                mnemonic: json["mnemonic"] as? String,
                privateKey: json["privateKey"] as? String,
                publicKey: json["publicKey"] as? String,
                chain: chain
            )
        }

        // Fallback: parse text output
        var address = ""
        var mnemonic: String?
        var privateKey: String?

        for line in output.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.lowercased().contains("address:") || trimmed.lowercased().contains("principal:") {
                address = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
            } else if trimmed.lowercased().contains("mnemonic:") {
                mnemonic = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
            } else if trimmed.lowercased().contains("private") && trimmed.contains(":") {
                privateKey = trimmed.components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
            }
        }

        guard !address.isEmpty else {
            throw CLIError.parseError("Could not extract wallet address from CLI output")
        }

        return CLIWalletResult(
            address: address,
            mnemonic: mnemonic,
            privateKey: privateKey,
            publicKey: nil,
            chain: chain
        )
    }
}

/// Parsed result from CLI wallet operations
struct CLIWalletResult {
    let address: String
    let mnemonic: String?
    let privateKey: String?
    let publicKey: String?
    let chain: Chain
}
