import React, { useState, useEffect } from 'react';
import TodoList from './components/TodoList';

export interface Todo {
  id: number;
  text: string;
  completed: boolean;
}

function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [inputValue, setInputValue] = useState("");

  // Fixed: Removed infinite loop - no state update needed

  const handleAddTodo = () => {
    if (!inputValue) return;
    
    const newTodo: Todo = {
      id: Date.now(),
      text: inputValue,
      completed: false
    };

    // Fixed: Create new array instead of mutating state
    setTodos([...todos, newTodo]);
    
    setInputValue("");
  };

  const toggleTodo = (id: number) => {
    // Fixed: Create new array with updated todo object
    setTodos(todos.map(t =>
      t.id === id ? { ...t, completed: !t.completed } : t
    ));
  };

  return (
    <div>
      <h1>Buggy Todo App</h1>
      <div>
        <input 
          value={inputValue} 
          onChange={(e) => setInputValue(e.target.value)} 
          placeholder="Add a new task"
        />
        <button onClick={handleAddTodo}>Add</button>
      </div>
      <TodoList todos={todos} toggleTodo={toggleTodo} />
    </div>
  );
}

export default App;