/**
 * `tbd guidelines` - Find and output coding guidelines.
 *
 * Guidelines are reusable coding rules and best practices documents.
 * Give a name or description and tbd will find the matching guideline.
 */

import { Command } from 'commander';

import { DocCommandHandler, type DocCommandOptions } from '../lib/doc-command-handler.js';
import { DEFAULT_GUIDELINES_PATHS } from '../../lib/paths.js';

class GuidelinesHandler extends DocCommandHandler {
  constructor(command: Command) {
    super(command, {
      typeName: 'guideline',
      typeNamePlural: 'guidelines',
      paths: DEFAULT_GUIDELINES_PATHS,
    });
  }

  async run(query: string | undefined, options: DocCommandOptions): Promise<void> {
    await this.execute(async () => {
      await this.initCache();

      // List mode
      if (options.list) {
        await this.handleList(options.all);
        return;
      }

      // No query: show help
      if (!query) {
        await this.handleNoQuery();
        return;
      }

      // Query provided: try exact match first, then fuzzy
      await this.handleQuery(query);
    }, 'Failed to find guideline');
  }
}

export const guidelinesCommand = new Command('guidelines')
  .description('Find and output coding guidelines')
  .argument('[query]', 'Guideline name or description to search for')
  .option('--list', 'List all available guidelines')
  .option('--all', 'Include shadowed guidelines (use with --list)')
  .action(async (query: string | undefined, options: DocCommandOptions, command) => {
    const handler = new GuidelinesHandler(command);
    await handler.run(query, options);
  });
