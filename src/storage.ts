import * as vscode from "vscode";
import * as constants from "./constants";
import * as os from "os";
import * as path from "path";

export class Storage {

    constructor(
        private readonly storage: vscode.Memento
    ) {}

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
}