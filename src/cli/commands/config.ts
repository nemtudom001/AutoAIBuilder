import chalk from 'chalk';
import {
  loadGlobalConfig,
  runSetupWizard,
  showConfig,
  resetConfig,
} from '../../core/config-manager.js';

interface ConfigOptions {
  setup?: boolean;
  show?: boolean;
  reset?: boolean;
}

export async function configCommand(options: ConfigOptions): Promise<void> {
  if (options.setup) {
    await runSetupWizard();
    return;
  }
  
  if (options.reset) {
    await resetConfig();
    return;
  }
  
  if (options.show) {
    await showConfig();
    return;
  }
  
  // Default: show config
  const config = await loadGlobalConfig();
  
  if (!config || !config.setup_complete) {
    console.log(chalk.yellow('\nNo configuration found. Running setup...\n'));
    await runSetupWizard();
    return;
  }
  
  await showConfig();
  
  console.log(chalk.dim('Options:'));
  console.log(chalk.cyan('  ai-phases config --setup  ') + chalk.dim('Re-run setup wizard'));
  console.log(chalk.cyan('  ai-phases config --reset  ') + chalk.dim('Reset to defaults'));
  console.log();
}
