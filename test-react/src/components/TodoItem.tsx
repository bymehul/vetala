import React from 'react';
import { Todo } from '../App';

interface TodoItemProps {
  todo: Todo;
  toggleTodo: (id: number) => void;
}

export default function TodoItem({ todo, toggleTodo }: TodoItemProps) {
  return (
    <li>
      <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
        {todo.text}
      </span>
      <button onClick={() => toggleTodo(todo.id)}>
        Toggle
      </button>
    </li>
  );
}