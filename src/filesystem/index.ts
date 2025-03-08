#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { diffLines, createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
  process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p);
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map(dir =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
await Promise.all(args.map(async (dir) => {
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const WriteMultipleFilesArgsSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    encoding: z.string().optional().default('utf-8')
  }))
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const EditMultipleFilesArgsSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    edits: z.array(EditOperation),
    dryRun: z.boolean().default(false)
  }))
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListMultipleDirectoriesArgsSchema = z.object({
  paths: z.array(z.string())
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const MoveMultipleFilesArgsSchema = z.object({
  files: z.array(z.object({
    source: z.string(),
    destination: z.string()
  }))
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const GetMultipleFilesInfoArgsSchema = z.object({
  paths: z.array(z.string())
});

const DeleteFileArgsSchema = z.object({
  path: z.string(),
});

const DeleteMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string())
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

// Server setup
const server = new Server(
  {
    name: "secure-filesystem-server",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool implementations
async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

async function searchFiles(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const results: string[] = [];

  async function search(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      try {
        // Validate each path before processing
        await validatePath(fullPath);

        // Check if path matches any exclude pattern
        const relativePath = path.relative(rootPath, fullPath);
        const shouldExclude = excludePatterns.some(pattern => {
          const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
          return minimatch(relativePath, globPattern, { dot: true });
        });

        if (shouldExclude) {
          continue;
        }

        if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
          results.push(fullPath);
        }

        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch (error) {
        // Skip invalid paths during search
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}

// file editing and diffing utilities
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

async function applyFileEdits(
  filePath: string,
  edits: Array<{ oldText: string, newText: string }>,
  dryRun = false
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  // Apply edits sequentially
  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    // If exact match exists, use it
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    // Otherwise, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  // Format diff with appropriate number of backticks
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, 'utf-8');
  }

  return formattedDiff;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_file",
        description:
          "Read the complete contents of a file from the file system. " +
          "Handles various text encodings and provides detailed error messages " +
          "if the file cannot be read. Use this tool when you need to examine " +
          "the contents of a single file. Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
      },
      {
        name: "read_multiple_files",
        description:
          "Read the contents of multiple files simultaneously. This is more " +
          "efficient than reading files one by one when you need to analyze " +
          "or compare multiple files. Each file's content is returned with its " +
          "path as a reference. Failed reads for individual files won't stop " +
          "the entire operation. Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "write_file",
        description:
          "Create a new file or completely overwrite an existing file with new content. " +
          "Use with caution as it will overwrite existing files without warning. " +
          "Handles text content with proper encoding. Only works within allowed directories." +
          "Important: should always pass full paths to this tool. " +
          "Note: When writing content with line breaks, use '\n' not '\\n'.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
      },
      {
        name: "write_multiple_files",
        description:
          "Create or overwrite multiple files simultaneously in a single operation. " +
          "This tool significantly improves efficiency by allowing parallel file writing, " +
          "eliminating the need for sequential write operations. " +
          "Perfect for scenarios where multiple related files need to be created or updated together, " +
          "such as generating components with their corresponding test files, or creating a complete " +
          "project structure. Each file can specify its own encoding. " +
          "This parallel approach dramatically speeds up development workflows and AI-assisted coding. " +
          "Use with caution as it will overwrite existing files without warning. " +
          "Only works within allowed directories." +
          "Important: should always pass full paths to this tool. " +
          "Note: When writing content with line breaks, use '\n' not '\\n'.",
        inputSchema: zodToJsonSchema(WriteMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "edit_file",
        description:
          "Make line-based edits to a text file. Each edit replaces exact line sequences " +
          "with new content. Returns a git-style diff showing the changes made. " +
          "Only works within allowed directories." +
          "Important: should always pass full paths to this tool. " +
          "Note: When writing content with line breaks, use '\n' not '\\n'.",
        inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
      },
      {
        name: "edit_multiple_files",
        description:
          "Make line-based edits to multiple text files in a single operation. This tool significantly " +
          "improves efficiency by allowing parallel file editing, eliminating the need for sequential edit operations. " +
          "Perfect for scenarios where multiple related files need to be modified together, such as refactoring " +
          "across components, updating imports, or implementing cross-cutting changes. " +
          "Each file edit operation returns a git-style diff showing the changes made. " +
          "This parallel approach dramatically speeds up development workflows and AI-assisted coding. " +
          "Only works within allowed directories." +
          "Important: should always pass full paths to this tool. " +
          "Note: When writing content with line breaks, use '\n' not '\\n'.",
        inputSchema: zodToJsonSchema(EditMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "create_directory",
        description:
          "Create a new directory or ensure a directory exists. Can create multiple " +
          "nested directories in one operation. If the directory already exists, " +
          "this operation will succeed silently. Perfect for setting up directory " +
          "structures for projects or ensuring required paths exist. Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description:
          "Get a detailed listing of all files and directories in a specified path. " +
          "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
          "prefixes. This tool is essential for understanding directory structure and " +
          "finding specific files within a directory. Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "list_multiple_directories",
        description:
          "Get detailed listings of multiple directories in a single operation. This tool significantly " +
          "improves efficiency by allowing parallel directory scanning, eliminating the need for sequential listing operations. " +
          "Perfect for scenarios where you need to explore multiple related directories simultaneously, such as " +
          "comparing directory structures, gathering comprehensive project information, or analyzing related components. " +
          "Results clearly distinguish between files and directories with [FILE] and [DIR] prefixes, and each directory's " +
          "contents are clearly separated. This parallel approach dramatically speeds up exploration and information gathering. " +
          "Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(ListMultipleDirectoriesArgsSchema) as ToolInput,
      },
      {
        name: "directory_tree",
        description:
          "Get a recursive tree view of files and directories as a JSON structure. " +
          "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
          "Files have no children array, while directories always have a children array (which may be empty). " +
          "The output is formatted with 2-space indentation for readability. Only works within allowed directories." +
          "Important: When you call this tool, you must be sure it is not a project root which may contain '.git/' or '.node_modules/' directories, which are too large to break the conversation.",
        inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema) as ToolInput,
      },
      {
        name: "move_file",
        description:
          "Move or rename files and directories. Can move files between directories " +
          "and rename them in a single operation. If the destination exists, the " +
          "operation will fail. Works across different directories and can be used " +
          "for simple renaming within the same directory. Both source and destination must be within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
      },
      {
        name: "move_multiple_files",
        description:
          "Move or rename multiple files and directories in a single operation. This tool significantly " +
          "improves efficiency by allowing parallel file operations, eliminating the need for sequential moves. " +
          "Perfect for scenarios where multiple related files need to be reorganized together, such as " +
          "restructuring project directories, migrating components, or implementing bulk file operations. " +
          "Each operation can move files between directories and rename them simultaneously. " +
          "This parallel approach dramatically speeds up development workflows and file organization tasks. " +
          "All source and destination paths must be within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(MoveMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "search_files",
        description:
          "Recursively search for files and directories matching a pattern. " +
          "Searches through all subdirectories from the starting path. The search " +
          "is case-insensitive and matches partial names. Returns full paths to all " +
          "matching items. Great for finding files when you don't know their exact location. " +
          "Only searches within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "get_file_info",
        description:
          "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
          "information including size, creation time, last modified time, permissions, " +
          "and type. This tool is perfect for understanding file characteristics " +
          "without reading the actual content. Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
      },
      {
        name: "get_multiple_files_info",
        description:
          "Retrieve detailed metadata about multiple files or directories in a single operation. This tool significantly " +
          "improves efficiency by allowing parallel metadata retrieval, eliminating the need for sequential operations. " +
          "Perfect for scenarios where you need to analyze multiple files simultaneously, such as comparing file timestamps, " +
          "checking permissions across a set of files, or gathering comprehensive information about project assets. " +
          "Returns comprehensive information including size, creation time, last modified time, permissions, and type for each file. " +
          "Results are clearly separated by file path. This parallel approach dramatically speeds up information gathering. " +
          "Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(GetMultipleFilesInfoArgsSchema) as ToolInput,
      },
      {
        name: "delete_file",
        description:
          "Deletes a file at the specified path. The operation will fail gracefully if:" +
          "    - The file doesn't exist" +
          "    - The operation is rejected for security reasons" +
          "    - The file cannot be deleted" +
          "Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(DeleteFileArgsSchema) as ToolInput,
      },
      {
        name: "delete_multiple_files",
        description:
          "Delete multiple files in a single operation. This tool significantly " +
          "improves efficiency by allowing parallel file deletion, eliminating the need for sequential delete operations. " +
          "Perfect for scenarios where multiple related files need to be removed together, such as cleaning up temporary files, " +
          "removing generated assets, or implementing bulk file operations. " +
          "Each operation will fail gracefully if the file doesn't exist, the operation is rejected for security reasons, " +
          "or the file cannot be deleted. Results are clearly separated by file path. " +
          "This parallel approach dramatically speeds up file management tasks. " +
          "Only works within allowed directories." +
          "Important: should always pass full paths to this tool.",
        inputSchema: zodToJsonSchema(DeleteMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "list_allowed_directories",
        description:
          "Returns the list of directories that this server is allowed to access. " +
          "Use this to understand which directories are available before trying to access files.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});


server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await fs.readFile(validPath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "read_multiple_files": {
        const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_multiple_files: ${parsed.error}`);
        }
        const results = await Promise.all(
          parsed.data.paths.map(async (filePath: string) => {
            try {
              const validPath = await validatePath(filePath);
              const content = await fs.readFile(validPath, "utf-8");
              return `${filePath}:\n${content}\n`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `${filePath}: Error - ${errorMessage}`;
            }
          }),
        );
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }

      case "write_file": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.writeFile(validPath, parsed.data.content, "utf-8");
        return {
          content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
        };
      }

      case "write_multiple_files": {
        const parsed = WriteMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_multiple_files: ${parsed.error}`);
        }

        const results = await Promise.all(
          parsed.data.files.map(async (file) => {
            try {
              const validPath = await validatePath(file.path);
              await fs.writeFile(validPath, file.content, (file.encoding || 'utf-8') as any);
              return `Successfully wrote to ${file.path}`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `Error writing to ${file.path}: ${errorMessage}`;
            }
          })
        );

        return {
          content: [{ type: "text", text: results.join("\n") }],
        };
      }

      case "edit_file": {
        const parsed = EditFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await applyFileEdits(validPath, parsed.data.edits, parsed.data.dryRun);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "edit_multiple_files": {
        const parsed = EditMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for edit_multiple_files: ${parsed.error}`);
        }

        const results = await Promise.all(
          parsed.data.files.map(async (file) => {
            try {
              const validPath = await validatePath(file.path);
              const result = await applyFileEdits(validPath, file.edits, file.dryRun);
              return `File: ${file.path}\n${result}`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `Error editing ${file.path}: ${errorMessage}`;
            }
          })
        );

        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }

      case "create_directory": {
        const parsed = CreateDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.mkdir(validPath, { recursive: true });
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
        };
      }

      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "list_multiple_directories": {
        const parsed = ListMultipleDirectoriesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_multiple_directories: ${parsed.error}`);
        }

        const results = await Promise.all(
          parsed.data.paths.map(async (dirPath) => {
            try {
              const validPath = await validatePath(dirPath);
              const entries = await fs.readdir(validPath, { withFileTypes: true });
              const formatted = entries
                .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
                .join("\n");
              return `Directory: ${dirPath}\n${formatted}`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `Error listing ${dirPath}: ${errorMessage}`;
            }
          })
        );

        return {
          content: [{ type: "text", text: results.join("\n\n") }],
        };
      }

      case "directory_tree": {
        const parsed = DirectoryTreeArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for directory_tree: ${parsed.error}`);
        }

        interface TreeEntry {
          name: string;
          type: 'file' | 'directory';
          children?: TreeEntry[];
        }

        async function buildTree(currentPath: string): Promise<TreeEntry[]> {
          const validPath = await validatePath(currentPath);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const result: TreeEntry[] = [];

          for (const entry of entries) {
            const entryData: TreeEntry = {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file'
            };

            if (entry.isDirectory()) {
              const subPath = path.join(currentPath, entry.name);
              entryData.children = await buildTree(subPath);
            }

            result.push(entryData);
          }

          return result;
        }

        const treeData = await buildTree(parsed.data.path);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(treeData, null, 2)
          }],
        };
      }

      case "move_file": {
        const parsed = MoveFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
        }
        const validSourcePath = await validatePath(parsed.data.source);
        const validDestPath = await validatePath(parsed.data.destination);
        await fs.rename(validSourcePath, validDestPath);
        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }

      case "move_multiple_files": {
        const parsed = MoveMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for move_multiple_files: ${parsed.error}`);
        }

        const results = await Promise.all(
          parsed.data.files.map(async (file) => {
            try {
              const validSourcePath = await validatePath(file.source);
              const validDestPath = await validatePath(file.destination);
              await fs.rename(validSourcePath, validDestPath);
              return `Successfully moved ${file.source} to ${file.destination}`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `Error moving ${file.source} to ${file.destination}: ${errorMessage}`;
            }
          })
        );

        return {
          content: [{ type: "text", text: results.join("\n") }],
        };
      }

      case "search_files": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const results = await searchFiles(validPath, parsed.data.pattern, parsed.data.excludePatterns);
        return {
          content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches found" }],
        };
      }

      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const info = await getFileStats(validPath);
        return {
          content: [{
            type: "text", text: Object.entries(info)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n")
          }],
        };
      }

      case "get_multiple_files_info": {
        const parsed = GetMultipleFilesInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_multiple_files_info: ${parsed.error}`);
        }

        const results = await Promise.all(
          parsed.data.paths.map(async (filePath) => {
            try {
              const validPath = await validatePath(filePath);
              const info = await getFileStats(validPath);
              return `File: ${filePath}\n${Object.entries(info)
                .map(([key, value]) => `  ${key}: ${value}`)
                .join("\n")}`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `Error getting info for ${filePath}: ${errorMessage}`;
            }
          })
        );

        return {
          content: [{ type: "text", text: results.join("\n\n") }],
        };
      }

      case "delete_file": {
        const parsed = DeleteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for delete_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.unlink(validPath);
        return {
          content: [{ type: "text", text: `Successfully deleted file ${parsed.data.path}` }],
        };
      }

      case "delete_multiple_files": {
        const parsed = DeleteMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for delete_multiple_files: ${parsed.error}`);
        }

        const results = await Promise.all(
          parsed.data.paths.map(async (filePath) => {
            try {
              const validPath = await validatePath(filePath);
              await fs.unlink(validPath);
              return `Successfully deleted file ${filePath}`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `Error deleting ${filePath}: ${errorMessage}`;
            }
          })
        );

        return {
          content: [{ type: "text", text: results.join("\n") }],
        };
      }

      case "list_allowed_directories": {
        return {
          content: [{
            type: "text",
            text: `Allowed directories:\n${allowedDirectories.join('\n')}`
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Secure MCP Filesystem Server running on stdio");
  console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
