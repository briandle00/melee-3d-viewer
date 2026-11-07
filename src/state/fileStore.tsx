import { batch } from "solid-js";
import { createStore } from "solid-js/store";
import { send } from "~/workerClient";
import { ReplayStub } from "~/state/selectionStore";

export interface FileStore {
  files: File[];
  stubs: ReplayStub[];
  parseProgress: number;
  urlStartFrame?: number;
  /** the last load's files that could not be read, and how many were read but are not ones these players play */
  failed: string[];
  skipped: number;
}

const [state, setState] = createStore<FileStore>({
  files: [],
  stubs: [],
  parseProgress: 0,
  failed: [],
  skipped: 0,
});

export const fileStore = state;
export async function load(files: File[], startFrame?: number): Promise<void> {
  setState("parseProgress", 0);
  setState("urlStartFrame", startFrame);

  const {
    goodFilesAndSettings,
    skipCount,
    failedFilenames,
  }: {
    goodFilesAndSettings: Array<[File, ReplayStub]>;
    failedFilenames: string[];
    skipCount: number;
  } = await send(files, () => setState("parseProgress", (p) => p + 1));

  // Save results to the store
  batch(() => {
    setState("failed", failedFilenames);
    setState("skipped", skipCount);
    setState(
      "stubs",
      goodFilesAndSettings.map(([, settings]) => settings)
    );
    setState(
      "files",
      goodFilesAndSettings.map(([file]) => file)
    );
  });
}
