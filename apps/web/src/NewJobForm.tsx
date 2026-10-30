import type { RecipeInfo } from "@binlight/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { askForRecipe, createJob, listRecipes, uploadFile } from "./api.js";

/** One target: an uploaded file or a path on this machine. */
interface TargetInput {
  path: string;
  file?: File | undefined;
}

export function NewJobForm({
  onCreated,
  aiOn,
}: {
  onCreated: (id: string) => void;
  aiOn: boolean;
}) {
  const [recipes, setRecipes] = useState<RecipeInfo[] | undefined>();
  const [recipeId, setRecipeId] = useState<string | undefined>();
  const [inputs, setInputs] = useState<TargetInput[]>([{ path: "" }]);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const form = useRef<HTMLFormElement>(null);
  const [question, setQuestion] = useState("");
  const [suggestion, setSuggestion] = useState<string | undefined>();

  async function ask() {
    setSuggestion(undefined);
    setError(undefined);
    setBusy("Asking Claude which recipe fits…");
    try {
      const s = await askForRecipe(question);
      if (s.recipe) {
        setRecipeId(s.recipe);
        setSuggestion(
          `Picked "${recipes?.find((r) => r.id === s.recipe)?.title ?? s.recipe}": ${s.reason}`,
        );
      } else {
        setSuggestion(`No recipe covers this yet: ${s.reason}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => {
    listRecipes().then(
      (list) => {
        setRecipes(list);
        setRecipeId((current) => current ?? list[0]?.id);
      },
      (err: unknown) =>
        setError(`Could not load recipes: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, []);

  const recipe = recipes?.find((r) => r.id === recipeId);
  const targetCount = recipe?.targets ?? 1;

  function update(i: number, change: Partial<TargetInput>) {
    setInputs((prev) => {
      const next = Array.from({ length: targetCount }, (_, k) => prev[k] ?? { path: "" });
      next[i] = { ...next[i], path: next[i]?.path ?? "", ...change };
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!recipe) return;
    try {
      const targets: string[] = [];
      for (let i = 0; i < recipe.targets; i++) {
        const input = inputs[i] ?? { path: "" };
        let target = input.path.trim();
        if (input.file) {
          setBusy(`Uploading ${input.file.name}…`);
          target = (await uploadFile(input.file)).path;
        }
        if (!target) {
          setError(`Choose a file or enter a path for "${recipe.targetLabels[i]}".`);
          return;
        }
        targets.push(target);
      }
      setBusy("Starting job…");
      const job = await createJob(recipe.id, targets, fresh);
      setInputs([{ path: "" }]);
      // File inputs keep showing their file until the form is reset.
      for (const el of form.current?.querySelectorAll<HTMLInputElement>('input[type="file"]') ??
        []) {
        el.value = "";
      }
      onCreated(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <form ref={form} className="card" onSubmit={(e) => void submit(e)}>
      <h2>New job</h2>
      {aiOn && recipes && (
        <div className="ask">
          <label>
            Ask in your own words
            <span className="ask-row">
              <input
                type="text"
                placeholder="Does this phone home?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <button
                type="button"
                className="secondary"
                disabled={!question.trim() || busy !== undefined}
                onClick={() => void ask()}
              >
                Find a recipe
              </button>
            </span>
          </label>
          <p className="hint">Your question and the list of recipes are sent to Claude.</p>
          {suggestion && <p className="small">{suggestion}</p>}
        </div>
      )}
      {!recipes && !error && <p className="muted">Loading recipes…</p>}
      {recipes && (
        <fieldset className="recipes">
          <legend>Recipe</legend>
          {recipes.map((r) => (
            <label key={r.id} className={r.id === recipeId ? "recipe selected" : "recipe"}>
              <input
                type="radio"
                name="recipe"
                value={r.id}
                checked={r.id === recipeId}
                onChange={() => setRecipeId(r.id)}
              />
              <span>
                <strong>{r.title}</strong>
                <span className="question">{r.question}</span>
                {r.id === recipeId && (
                  <span className="small muted">
                    {r.description}
                    {r.needsDeep ? " Needs a disassembler." : " No disassembler needed."}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {recipe?.targetLabels.map((label, i) => (
        <div key={`${recipe.id}-${i}`} className="target-input">
          {recipe.targets > 1 && <h3>{label}</h3>}
          <label>
            Upload a binary
            <input
              type="file"
              onChange={(e) => update(i, { file: e.target.files?.[0], path: "" })}
            />
          </label>
          <label>
            or a path on this machine
            <input
              type="text"
              placeholder="/opt/homebrew/bin/kubectl or /Applications/Foo.app"
              value={inputs[i]?.path ?? ""}
              disabled={inputs[i]?.file !== undefined}
              onChange={(e) => update(i, { path: e.target.value })}
            />
          </label>
        </div>
      ))}
      <p className="hint">
        Only analyse software you own, open-source software, or software you are authorised to
        inspect.
      </p>
      <label className="inline">
        <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
        Ignore cached results
      </label>
      <button type="submit" disabled={busy !== undefined || !recipe}>
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
