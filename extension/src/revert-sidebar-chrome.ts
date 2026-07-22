import * as vscode from 'vscode';

/** Values previously written to global workbench.colorCustomizations — remove on activate. */
const INJECTED_SIDEBAR_COLORS: Readonly<Record<string, string>> = {
  'sideBar.background': '#030303',
  'sideBar.border': '#141414',
  'sideBar.foreground': '#a39e94',
  'sideBarTitle.background': '#030303',
  'sideBarTitle.foreground': '#e8d5a3',
  'sideBarTitle.border': '#1a1508',
  'sideBarSectionHeader.background': '#030303',
  'sideBarSectionHeader.foreground': '#e8d5a3',
  'sideBarSectionHeader.border': '#1a1508',
  'toolbar.hoverBackground': 'rgba(201, 169, 98, 0.12)',
  'toolbar.activeBackground': 'rgba(201, 169, 98, 0.18)',
};

/** Strip extension-injected sidebar colors so Copilot/other views are not affected. */
export async function revertInjectedSidebarChrome(): Promise<void> {
  const workbenchConfig = vscode.workspace.getConfiguration('workbench');
  const current =
    workbenchConfig.get<Record<string, string | undefined>>(
      'colorCustomizations',
    ) ?? {};

  const next: Record<string, string> = { ...current };
  let changed = false;

  for (const [key, value] of Object.entries(INJECTED_SIDEBAR_COLORS)) {
    if (next[key] === value) {
      delete next[key];
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  await workbenchConfig.update(
    'colorCustomizations',
    Object.keys(next).length > 0 ? next : undefined,
    vscode.ConfigurationTarget.Global,
  );
}
