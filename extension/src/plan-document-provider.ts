import * as vscode from 'vscode';

export class PlanDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'vertex-plan';
  private plans = new Map<string, string>();
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  get onDidChange(): vscode.Event<vscode.Uri> {
    return this.onDidChangeEmitter.event;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.plans.get(uri.authority) ?? '';
  }

  updatePlan(chatId: string, content: string): void {
    const current = this.plans.get(chatId) ?? '';
    if (current !== content) {
      this.plans.set(chatId, content);
      const uri = vscode.Uri.parse(`${PlanDocumentProvider.scheme}://${chatId}/plan.md`);
      this.onDidChangeEmitter.fire(uri);
    }
  }

  appendPlanChunk(chatId: string, content: string): void {
    const current = this.plans.get(chatId) ?? '';
    this.updatePlan(chatId, current + content);
  }

  async openPlanTab(chatId: string): Promise<void> {
    const uri = vscode.Uri.parse(`${PlanDocumentProvider.scheme}://${chatId}/plan.md`);
    
    // Check if it's already open
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
          return;
        }
      }
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
      preview: true,
    });
  }
}
