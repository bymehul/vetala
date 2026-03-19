import { useMemo, useState } from "react";

type Todo = {
  id: number;
  title: string;
  done: boolean;
};

const initialTodos: Todo[] = [
  { id: 1, title: "Review the current UI flow", done: false },
  { id: 2, title: "Check keyboard shortcuts", done: true },
  { id: 3, title: "Test skill auto-routing", done: false }
];

export default function App() {
  const [query, setQuery] = useState("");
  const [todos, setTodos] = useState<Todo[]>(initialTodos);

  const filteredTodos = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return todos;
    }
    return todos.filter((todo) => todo.title.toLowerCase().includes(normalized));
  }, [query, todos]);

  const completedCount = useMemo(
    () => todos.filter((todo) => todo.done).length,
    [todos]
  );

  const toggleTodo = (id: number) => {
    setTodos((current) =>
      current.map((todo) =>
        todo.id === id ? { ...todo, done: !todo.done } : todo
      )
    );
  };

  return (
    <main
      style={{
        fontFamily: "sans-serif",
        maxWidth: 720,
        margin: "40px auto",
        padding: 24,
        lineHeight: 1.5
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <p style={{ margin: 0, color: "#555" }}>Test React Fixture</p>
        <h1 style={{ margin: "8px 0 12px" }}>Vetala Skill Routing Demo</h1>
        <p style={{ margin: 0, color: "#444" }}>
          Use this file to test React-focused prompts like review, refactor, or
          performance improvements.
        </p>
      </header>

      <section
        aria-label="Todo filters"
        style={{
          display: "grid",
          gap: 12,
          marginBottom: 24
        }}
      >
        <label htmlFor="todo-search">Search tasks</label>
        <input
          id="todo-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search todos"
          style={{
            padding: "10px 12px",
            border: "1px solid #ccc",
            borderRadius: 8
          }}
        />
        <p style={{ margin: 0, color: "#666" }}>
          {completedCount} of {todos.length} completed
        </p>
      </section>

      <section aria-label="Todo list">
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
          {filteredTodos.map((todo) => (
            <li
              key={todo.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: 16,
                border: "1px solid #e5e5e5",
                borderRadius: 12
              }}
            >
              <span
                style={{
                  textDecoration: todo.done ? "line-through" : "none",
                  color: todo.done ? "#777" : "#111"
                }}
              >
                {todo.title}
              </span>
              <button
                type="button"
                onClick={() => toggleTodo(todo.id)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #222",
                  background: todo.done ? "#f3f3f3" : "#111",
                  color: todo.done ? "#111" : "#fff",
                  cursor: "pointer"
                }}
              >
                {todo.done ? "Undo" : "Complete"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
