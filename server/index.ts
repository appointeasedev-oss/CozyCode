import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { generateResponse } from './openrouter';
import fs from 'fs/promises';
import path from 'path';
import type { ChildProcess } from 'child_process';

console.log("Starting server...");

// A simple in-memory store to keep track of running Vite servers and their ports.
// Key: projectId, Value: { process: ChildProcess, port: number }
const runningPreviews = new Map<string, { process: ChildProcess; port: number }>();
let nextPreviewPort = 5174; // Start Vite previews from this port
let currentActiveProject: string | null = null; // Track the currently active project

// Function to find an available port (simplified for local use)
const getNextPort = () => nextPreviewPort++;

/**
 * A shared function to find or start a Vite preview server for a given project.
 * This avoids duplicating code in our route handlers.
 */
const getOrCreatePreviewServer = async (projectId: string) => {
  if (runningPreviews.has(projectId)) {
    return runningPreviews.get(projectId);
  }

  const projectPath = path.join(process.cwd(), 'projects', projectId);
  try {
    await fs.access(projectPath); // Check if project folder exists
    const port = getNextPort();
    console.log(`[${projectId}] No preview server found. Starting on port ${port}...`);

    const viteProcess = Bun.spawn(['bun', 'vite', '--port', String(port)], {
      cwd: projectPath,
      // You can uncomment these lines to see the Vite server's output in your main terminal
      // stdout: 'inherit',
      // stderr: 'inherit',
    });
    
    const preview = { process: viteProcess, port };
    runningPreviews.set(projectId, preview);
    // Give Vite a moment to start up before we try to connect
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log(`[${projectId}] Preview server should now be running.`);
    return preview;

  } catch (error) {
    console.error(`[${projectId}] Failed to start preview server:`, error);
    return null;
  }
};

const app = new Elysia()
  .use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }))
  .get('/', () => 'Open Lovable Server is running')
  
  .post('/api/generate', async ({ body }) => { 
    console.log("Generate API called");
    const { prompt } = body;
    
    const stream = new ReadableStream({
      start(controller) {
        generateResponse(prompt, controller);
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }, {
    body: t.Object({ prompt: t.String() })
  })

  .get('/api/projects', async () => {
    const projectsDir = path.join(process.cwd(), 'projects');
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      const projects = entries
        .filter(entry => entry.isDirectory())
        .map(entry => ({ id: entry.name }));
      return { success: true, projects };
    } catch (error) {
      console.error('Error reading projects directory:', error);
      return { success: true, projects: [] }; // Return empty array if directory doesn't exist
    }
  })

  .post('/api/create-project', async ({ body }) => {
    const { projectId } = body;
    const projectPath = path.join(process.cwd(), 'projects', projectId);
    const templatePath = path.join(process.cwd(), 'template');
    try {
      await fs.mkdir(projectPath, { recursive: true });
      await fs.cp(templatePath, projectPath, { recursive: true });
      const proc = Bun.spawn(['bun', 'install'], { cwd: projectPath, stdout: 'pipe', stderr: 'pipe' });
      const installExitCode = await proc.exited;
      if (installExitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`'bun install' failed: ${stderr}`);
      }
      return { success: true, message: 'Project created successfully.' };
    } catch (error) {
      console.error(`[${projectId}] Error during project setup:`, error);
      return new Response(JSON.stringify({ success: false, message: (error as Error).message }), { status: 500 });
    }
  }, {
    body: t.Object({ projectId: t.String(), prompt: t.String(), model: t.String() })
  })

  .delete('/api/delete-project/:projectId', async ({ params }) => {
    const { projectId } = params;
    const projectPath = path.join(process.cwd(), 'projects', projectId);
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
      return { success: true, message: `Project ${projectId} deleted.` };
    } catch (error) {
      console.error(`[${projectId}] Error deleting project directory:`, error);
      return new Response(JSON.stringify({ success: false, message: (error as Error).message }), { status: 500 });
    }
  }, {
    params: t.Object({ projectId: t.String() })
  })

  .post('/api/start-preview', async ({ body }) => {
    const { projectId } = body;
    try {
      const preview = await getOrCreatePreviewServer(projectId);
      if (preview) {
        return { success: true, message: 'Preview server started', port: preview.port };
      } else {
        return new Response(JSON.stringify({ success: false, message: 'Failed to start preview server' }), { status: 500 });
      }
    } catch (error) {
      console.error(`Failed to start preview for ${projectId}:`, error);
      return new Response(JSON.stringify({ success: false, message: (error as Error).message }), { status: 500 });
    }
  }, {
    body: t.Object({ projectId: t.String() })
  })

  .post('/api/install-dependency', async ({ body }) => {
    const { projectId, packageName } = body;
    const projectPath = path.join(process.cwd(), 'projects', projectId);
    try {
      console.log(`Installing ${packageName} in project ${projectId}`);
      const proc = Bun.spawn(['bun', 'add', packageName], { 
        cwd: projectPath, 
        stdout: 'pipe', 
        stderr: 'pipe' 
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Failed to install ${packageName}: ${stderr}`);
      }
      return { success: true, message: `Successfully installed ${packageName}` };
    } catch (error) {
      console.error(`Error installing ${packageName}:`, error);
      return new Response(JSON.stringify({ success: false, message: (error as Error).message }), { status: 500 });
    }
  }, {
    body: t.Object({ projectId: t.String(), packageName: t.String() })
  })

  .post('/api/update-file', async ({ body }) => {
    const { projectId, operation } = body;
    const projectsDir = path.resolve(process.cwd(), 'projects');
    const projectPath = path.resolve(projectsDir, projectId);
    const sanitize = (filePath: string) => {
      const safePath = path.resolve(projectPath, filePath);
      if (!safePath.startsWith(projectPath)) throw new Error(`Path traversal attempt: ${filePath}`);
      return safePath;
    };
    try {
      switch (operation.type) {
        case 'write':
          if (!operation.path || typeof operation.content !== 'string') throw new Error("Write op missing path/content.");
          const writePath = sanitize(operation.path);
          await fs.mkdir(path.dirname(writePath), { recursive: true });
          await fs.writeFile(writePath, operation.content);
          break;
        case 'delete':
          if (!operation.path) throw new Error("Delete op missing path.");
          const deletePath = sanitize(operation.path);
          await fs.rm(deletePath, { recursive: true, force: true });
          break;
        case 'rename':
          if (!operation.oldPath || !operation.newPath) throw new Error("Rename op missing paths.");
          const oldPath = sanitize(operation.oldPath);
          const newPath = sanitize(operation.newPath);
          await fs.rename(oldPath, newPath);
          break;
        default:
          throw new Error(`Unsupported operation: ${operation.type}`);
      }
      return { success: true };
    } catch (error) {
      console.error(`[${projectId}] Error performing file op:`, error);
      return new Response(JSON.stringify({ success: false, message: (error as Error).message }), { status: 500 });
    }
  }, {
    body: t.Object({
      projectId: t.String(),
      operation: t.Object({
        type: t.String(),
        path: t.Optional(t.String()),
        content: t.Optional(t.String()),
        oldPath: t.Optional(t.String()),
        newPath: t.Optional(t.String()),
      })
    })
  })

  .listen(3002);

console.log(`🦊 Open Lovable server is running at ${app.server?.hostname}:${app.server?.port}`);
