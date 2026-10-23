import { useRef, useState, type FormEvent } from "react";
import { createJob, uploadFile } from "./api.js";

export function NewJobForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [path, setPath] = useState("");
  const [file, setFile] = useState<File | undefined>();
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      let target = path.trim();
      if (file) {
        setBusy(`Uploading ${file.name}…`);
        target = (await uploadFile(file)).path;
      }
      if (!target) {
        setError("Choose a file or enter a path.");
        return;
      }
      setBusy("Starting job…");
      const job = await createJob(target, fresh);
      setPath("");
      setFile(undefined);
      // A file input keeps showing its file until its value is cleared.
      if (fileInput.current) fileInput.current.value = "";
      onCreated(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>New job</h2>
      <label>
        Upload a binary
        <input
          ref={fileInput}
          type="file"
          onChange={(e) => {
            setFile(e.target.files?.[0]);
            if (e.target.files?.[0]) setPath("");
          }}
        />
      </label>
      <label>
        or a path on this machine
        <input
          type="text"
          placeholder="/opt/homebrew/bin/kubectl or /Applications/Foo.app"
          value={path}
          disabled={file !== undefined}
          onChange={(e) => setPath(e.target.value)}
        />
      </label>
      <p className="hint">
        Only analyse software you own, open-source software, or software you are authorised to
        inspect.
      </p>
      <label className="inline">
        <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
        Ignore cached results
      </label>
      <button type="submit" disabled={busy !== undefined}>
        {busy ?? "Analyse"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
