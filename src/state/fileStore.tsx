import { batch } from "solid-js";
import { createStore } from "solid-js/store";
import { send } from "~/workerClient";
import { ReplayStub } from "~/state/selectionStore";

export interface FileStore {
  files: File[];
  stubs: ReplayStub[];
  parseProgress: number;
  urlStartFrame?: number;
}

const [state, setState] = createStore<FileStore>({
  files: [],
  stubs: [],
  parseProgress: 0,
});

export const fileStore = state;
export async function load(files: File[], startFrame?: number): Promise<void> {
  setState("parseProgress", 0);
  setState("urlStartFrame", startFrame);

  const {
    goodFilesAndSettings,
  }: {
    goodFilesAndSettings: Array<[File, ReplayStub]>;
    failedFilenames: string[];
    skipCount: number;
  } = await send(files, () => setState("parseProgress", (p) => p + 1));

  // Save results to the store
  batch(() => {
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
