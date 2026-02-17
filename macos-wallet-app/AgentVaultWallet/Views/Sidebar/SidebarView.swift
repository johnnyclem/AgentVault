import SwiftUI

/// Navigation sidebar with wallet groups and actions
struct SidebarView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState

    var body: some View {
        List(selection: $appState.selectedDestination) {
            // Main navigation
            Section {
                NavigationLink(value: NavigationDestination.dashboard) {
                    Label("Dashboard", systemImage: "square.grid.2x2")
                }

                NavigationLink(value: NavigationDestination.walletList) {
                    Label {
                        HStack {
                            Text("All Wallets")
                            Spacer()
                            Text("\(walletStore.totalWalletCount)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.quaternary, in: Capsule())
                        }
                    } icon: {
                        Image(systemName: "wallet.pass.fill")
                    }
                }
            }

            // Wallets by chain
            Section("Networks") {
                ForEach(Chain.allCases) { chain in
                    DisclosureGroup {
                        let chainWallets = walletStore.wallets.filter { $0.chain == chain }
                        if chainWallets.isEmpty {
                            Text("No wallets")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .padding(.leading, 4)
                        } else {
                            ForEach(chainWallets) { wallet in
                                NavigationLink(value: NavigationDestination.walletDetail(wallet.id)) {
                                    WalletSidebarRow(wallet: wallet)
                                }
                            }
                        }
                    } label: {
                        Label {
                            HStack {
                                Text(chain.displayName)
                                Spacer()
                                Text("\(walletStore.wallets.filter { $0.chain == chain }.count)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: chain.iconName)
                                .foregroundStyle(chain.color)
                        }
                    }
                }
            }

            // Tools
            Section("Tools") {
                NavigationLink(value: NavigationDestination.backup) {
                    Label("Backup & Restore", systemImage: "arrow.triangle.2.circlepath")
                }

                NavigationLink(value: NavigationDestination.settings) {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            sidebarActions
        }
        .navigationSplitViewColumnWidth(min: 220, ideal: 260)
    }

    private var sidebarActions: some View {
        VStack(spacing: 8) {
            Divider()

            HStack(spacing: 12) {
                Button {
                    appState.activeSheet = .createWallet
                } label: {
                    Label("Create", systemImage: "plus.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)

                Button {
                    appState.activeSheet = .importWallet
                } label: {
                    Label("Import", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .background(.bar)
    }
}

/// Compact wallet row for the sidebar
struct WalletSidebarRow: View {
    let wallet: Wallet

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(wallet.name)
                .font(.body)
                .lineLimit(1)

            Text(wallet.shortAddress)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}
