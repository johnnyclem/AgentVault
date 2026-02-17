import SwiftUI

@main
struct AgentVaultWalletApp: App {
    @StateObject private var walletStore = WalletStore()
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            MainView()
                .environmentObject(walletStore)
                .environmentObject(appState)
                .frame(minWidth: 900, minHeight: 600)
                .onAppear {
                    walletStore.loadWallets()
                    appState.checkEnvironment()
                }
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: true))
        .defaultSize(width: 1100, height: 720)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Wallet...") {
                    appState.activeSheet = .createWallet
                }
                .keyboardShortcut("n", modifiers: .command)

                Button("Import Wallet...") {
                    appState.activeSheet = .importWallet
                }
                .keyboardShortcut("i", modifiers: .command)

                Divider()

                Button("Backup All Wallets...") {
                    appState.activeSheet = .backup
                }
                .keyboardShortcut("b", modifiers: [.command, .shift])

                Button("Restore from Backup...") {
                    appState.activeSheet = .restore
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
            }
        }

        Settings {
            SettingsView()
                .environmentObject(walletStore)
                .environmentObject(appState)
        }
    }
}
