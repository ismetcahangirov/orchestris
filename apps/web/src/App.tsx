import { Route, Routes } from 'react-router-dom'
import Sidebar from './components/Sidebar.js'
import Contexts from './pages/Contexts.js'
import Dashboard from './pages/Dashboard.js'
import Ladder from './pages/Ladder.js'
import Providers from './pages/Providers.js'
import TaskView from './pages/TaskView.js'

export default function App(): React.JSX.Element {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contexts" element={<Contexts />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/ladder" element={<Ladder />} />
          <Route path="/tasks/:id" element={<TaskView />} />
        </Routes>
      </main>
    </div>
  )
}
