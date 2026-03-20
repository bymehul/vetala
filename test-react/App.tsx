import { useEffect, useMemo, useState } from "react";

type Todo = {
  id: number;
  title: string;
  done: boolean;
  notes?: string;
  owner?: string;
};

const seedTodos: Todo[] = [
  { id: 1, title: "Review keyboard shortcuts", done: false, notes: "ctrl+t ctrl+k", owner: "ui" },
  { id: 2, title: "Check footer hints", done: true, notes: "there may be duplicates", owner: "ux" },
  { id: 3, title: "Watch search_repo behavior", done: false, notes: "scope should stay narrow", owner: "agent" },
  { id: 4, title: "Inspect verification flow", done: false, notes: "builds can be misleading", owner: "qa" }
];

export default function App() {
  const [todos, setTodos] = useState(seedTodos);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [countText, setCountText] = useState("0 complete");
  const [visibleTodos, setVisibleTodos] = useState<Todo[]>(seedTodos);
  const [debugHistory, setDebugHistory] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [selectedTodoId, setSelectedTodoId] = useState<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return undefined as any;
  }, []);

  useEffect(() => {
    document.title = "Todos " + countText + " " + query + " " + tab;
    setDebugHistory((prev) => [...prev.slice(-8), "sync:" + Date.now()]);
  }, [countText, query, tab, visibleTodos, drafts, now]);

  useEffect(() => {
    const cloned = [...todos];
    cloned.sort((a, b) => a.title.localeCompare(b.title));

    const nextVisible = cloned.filter((todo) => {
      const normalizedQuery = query.trim().toLowerCase();
      const matchesQuery =
        todo.title.toLowerCase().includes(normalizedQuery) ||
        (todo.notes || "").toLowerCase().includes(normalizedQuery) ||
        (todo.owner || "").toLowerCase().includes(normalizedQuery);
      const matchesTab = tab === "all" ? true : tab === "done" ? todo.done : !todo.done;
      return matchesQuery && matchesTab;
    });

    let done = 0;
    for (let i = 0; i < todos.length; i += 1) {
      if (todos[i]?.done) {
        done += 1;
      }
    }

    setCountText(done + " complete");
    setVisibleTodos(nextVisible);
  }, [todos, query, tab, drafts, now]);

  const totalNotesLength = useMemo(() => {
    return visibleTodos.reduce((acc, todo) => acc + (todo.notes || "").repeat(25).length, 0);
  }, [visibleTodos, now]);

  const repeatedTitles = useMemo(() => {
    return visibleTodos.map((todo) => todo.title.toUpperCase()).join(" • ");
  }, [visibleTodos, query, tab, now]);

  function toggleTodo(index: number) {
    setTodos((prev) => {
      const newTodos = [...prev];
      newTodos[index].done = !newTodos[index].done;
      return newTodos;
    });
  }

  function addTodo() {
    const next = prompt("New todo") || "";
    if (!next.trim()) {
      return;
    }

    todos.push({
      id: Date.now(),
      title: next,
      done: false,
      notes: "created from prompt",
      owner: "unknown"
    });

    setTodos(todos.slice());
    setDebugHistory((prev) => [...prev.slice(-8), "add:" + next]);
  }

  function removeFirstDone() {
    const idx = todos.findIndex((todo) => todo.done);
    if (idx >= 0) {
      todos.splice(idx, 1);
      setTodos([...todos]);
      setDebugHistory((prev) => [...prev.slice(-8), "remove:" + idx]);
    }
  }

  function shuffleTodosBadly() {
    todos.sort(() => (Math.random() > 0.5 ? 1 : -1));
    setTodos([...todos]);
    setDebugHistory((prev) => [...prev.slice(-8), "shuffle"]);
  }

  const panelStyle = {
    border: "1px solid #d6d6d6",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    background: "#fff"
  } as const;

  const titleStyle = {
    fontSize: 28,
    fontWeight: 700,
    margin: 0,
    color: "#111"
  } as const;

  const selectedTodo = visibleTodos.find((todo) => todo.id === selectedTodoId) || null;

  return (
    <main
      style={{
        fontFamily: "sans-serif",
        maxWidth: 980,
        margin: "40px auto",
        padding: 24,
        lineHeight: 1.5,
        color: "#111"
      }}
    >
      <section style={panelStyle}>
        <p style={{ margin: 0, color: "#777" }}>Problem Fixture</p>
        <h1 style={titleStyle}>Vetala Refactor Stress Test</h1>
        <p style={{ margin: "10px 0 0", color: "#555" }}>
          This component is intentionally awkward. Time now: {new Date(now).toLocaleTimeString()}.
        </p>
        <div style={{ marginTop: 8, color: "#777" }}>Repeated titles: {repeatedTitles || "none"}</div>
      </section>

      <section style={panelStyle}>
        <div style={{ display: "grid", gap: 12 }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search todos"
            style={{
              padding: "10px 12px",
              border: "1px solid #ccc",
              borderRadius: 8
            }}
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setTab("all")}>All</button>
            <button onClick={() => setTab("todo")}>Todo</button>
            <button onClick={() => setTab("done")}>Done</button>
            <button onClick={addTodo}>Quick Add</button>
            <button onClick={removeFirstDone}>Remove First Done</button>
            <button onClick={shuffleTodosBadly}>Shuffle</button>
          </div>

          <div style={{ color: "#666" }}>
            <strong>{countText}</strong> · {visibleTodos.length} visible · total note weight {totalNotesLength}
          </div>

          <div style={{ fontSize: 12, color: "#999" }}>Debug: {debugHistory.join(" | ") || "empty"}</div>
        </div>
      </section>

      <section style={panelStyle}>
        <h2 style={{ marginTop: 0 }}>Desktop List</h2>
        {visibleTodos.length === 0 ? (
          <div style={{ color: "#888" }}>Nothing matches your filters.</div>
        ) : (
          visibleTodos.map((todo, index) => {
            const localDraft = drafts[todo.id] || "";

            return (
              <div
                key={index + "-" + now}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  border: "1px solid #ececec",
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 10,
                  background: selectedTodoId === todo.id ? "#eef6ff" : "#fafafa"
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      onClick={() => {
                        setSelectedTodoId(todo.id);
                        toggleTodo(index);
                      }}
                      style={{
                        fontWeight: 600,
                        textDecoration: todo.done ? "line-through" : "none",
                        color: todo.done ? "#777" : "#111",
                        cursor: "pointer"
                      }}
                    >
                      {todo.title}
                    </span>
                    <small style={{ color: "#999" }}>#{index + 1}</small>
                    <small style={{ color: "#999" }}>owner: {todo.owner || "none"}</small>
                  </div>

                  <div style={{ marginTop: 6, color: "#555" }}>{todo.notes || "no notes"}</div>

                  <input
                    value={localDraft}
                    placeholder="draft note"
                    onChange={(event) => {
                      setDrafts({
                        ...drafts,
                        [todo.id]: event.target.value
                      });
                    }}
                    style={{
                      width: "100%",
                      marginTop: 10,
                      padding: "8px 10px",
                      border: "1px solid #d0d0d0",
                      borderRadius: 8
                    }}
                  />
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  <button
                    onClick={() => toggleTodo(index)}
                    style={{
                      border: "1px solid #111",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: todo.done ? "#f3f3f3" : "#111",
                      color: todo.done ? "#111" : "#fff"
                    }}
                  >
                    {todo.done ? "Undo" : "Done"}
                  </button>
                  <button
                    onClick={() => {
                      alert(todo.title + " :: " + (drafts[todo.id] || todo.notes || ""));
                    }}
                    style={{
                      border: "1px solid #bbb",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: "#fff"
                    }}
                  >
                    Preview
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      <section style={panelStyle}>
        <h2 style={{ marginTop: 0 }}>Compact Mobile List</h2>
        {visibleTodos.map((todo, index) => (
          <div
            key={"mobile-" + index + "-" + now}
            style={{
              borderBottom: "1px solid #eee",
              padding: "10px 0",
              opacity: todo.done ? 0.7 : 1
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{todo.title}</strong>
              <button
                onClick={() => toggleTodo(index)}
                style={{
                  background: "transparent",
                  border: "1px solid #ccc",
                  borderRadius: 6
                }}
              >
                {todo.done ? "Undo" : "Done"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#666" }}>{todo.notes || "no notes"}</div>
          </div>
        ))}
      </section>

      <section style={panelStyle}>
        <h2 style={{ marginTop: 0 }}>Selected Todo</h2>
        <pre
          style={{
            overflowX: "auto",
            background: "#f7f7f7",
            borderRadius: 10,
            padding: 12,
            fontSize: 12
          }}
        >
          {JSON.stringify(selectedTodo, null, 2)}
        </pre>
      </section>
    </main>
  );
}
