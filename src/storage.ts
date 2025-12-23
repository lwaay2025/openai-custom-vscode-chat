import * as vscode from "vscode";
import * as constants from "./constants";
import * as os from "os";
import * as path from "path";

export class Storage {
  constructor(private readonly storage: vscode.Memento) {}

  async setConfig(configPath: string): Promise<void> {
    await this.storage.update(constants.MODEL_CONFIG_FILE_PATH_KEY, configPath);
  }

  async getConfig(): Promise<string | undefined> {
    const configPath = this.storage.get<string>(constants.MODEL_CONFIG_FILE_PATH_KEY);
    if (configPath) {
      return configPath;
    }
    const defaultConfigPath = path.join(os.homedir(), constants.DEFAULT_MODEL_CONFIG_FILE_PATH);
    return defaultConfigPath;
  }

  async clearConfig(): Promise<void> {
    await this.storage.update(constants.MODEL_CONFIG_FILE_PATH_KEY, undefined);
  }

  async showAndSetConfig(): Promise<void> {
    const modelConfigExisting = await this.getConfig();
    const configPath = await vscode.window.showInputBox({
      title: "OpenAI custom model config",
      prompt: modelConfigExisting ? "Update your model config file path" : "Enter your model config file path",
      ignoreFocusOut: true,
      password: false,
      value: modelConfigExisting ?? "",
    });
    if (configPath === undefined) {
      return; // user canceled
    }
    if (!configPath.trim()) {
      await this.clearConfig();
      vscode.window.showInformationMessage("OpenAI Custom config cleared.");
      return;
    }
    await this.setConfig(configPath.trim());
    vscode.window.showInformationMessage("OpenAI Custom config saved.");
  }
}
