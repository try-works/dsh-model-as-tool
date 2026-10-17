/**
 * `@try-works/tool-mode-recipes` — declarative harness-model recipes, a provider-neutral
 * LLM broker, and the built-in `text_title` and `describe_image` recipes (RCP-01,
 * RCP-02, HLM-01, HLM-05, HLM-11).
 *
 * This package contains no model weights, no vendor HTTP code, no credentials and no
 * host imports. It is the piece a TMX 1.1 declarative package points at: a recipe file is
 * data, the broker turns it into one isolated request, and the built-ins are two recipes
 * that prove the path is generic (RCP-12).
 *
 * WHAT ITS TESTS DO AND DO NOT PROVE: every test in this package runs a DETERMINISTIC
 * FAKE PROVIDER. They prove the request shape (what is sent, and what is not), image
 * transport as typed media, and the policy decisions (destination, capability, budget,
 * recording, cancellation). They prove NOTHING about model quality, because no model ran.
 * Any claim about a real provider needs a real provider, recorded separately.
 *
 * @module @try-works/tool-mode-recipes
 */

export {
  describeRecipe,
  errorCodeOf,
  formatRecipeError,
  imageReference,
  INITIAL_MAX_IMAGE_INPUTS,
  INITIAL_MAX_OUTPUT_TOKENS,
  inputSchemaFor,
  parseRecipe,
  renderPrompt,
  validateRecipeInputs,
  FORBIDDEN_RECIPE_KEYS,
  RECIPE_TOP_LEVEL_KEYS,
  RESERVED_RECIPE_KEYS,
  type DescribedPolicy,
  type ParseRecipeOptions,
  type RecipeBindingResult,
  type RecipeErrorCode,
  type RecipeImageValue,
  type RecipeInputDeclaration,
  type RecipeInputKind,
  type RecipeInputMap,
  type RecipeManifest,
  type RecipeParseResult,
  type RecipePolicy,
  type RecipeToolIdentity,
  type RecipeValue,
} from './recipe-format.ts'

export {
  BrokerError,
  buildIsolatedRequest,
  HarnessBroker,
  INITIAL_HOST_POLICY,
  LOCAL_ONLY_HOST_POLICY,
  narrowBrokerPolicy,
  permitsDestination,
  type BrokerCompletion,
  type BrokerErrorCode,
  type BrokerHostPolicy,
  type BrokerImage,
  type BrokerOptions,
  type BrokerOutcome,
  type BrokerRecord,
  type BrokerRecordSink,
  type BrokerRequest,
  type CapabilityState,
  type LlmCompletion,
  type LlmProvider,
  type LlmUsage,
  type ProviderCapabilities,
  type ProviderDestination,
  type ProviderGrant,
  type ProviderIdentity,
  type RecipeIdentity,
  type RunOptions,
} from './broker.ts'

export {
  acceptTitle,
  createTextTitleTool,
  mayCallAnotherTool,
  mayRepairTitle,
  parseTitleResponse,
  SECTION_TITLE_LIMITS,
  TEXT_TITLE_CONTRACT,
  TEXT_TITLE_RECIPE,
  TEXT_TITLE_RECIPE_JSON,
  TEXT_TITLE_TOOL,
  type RawTitleResponse,
  type TextTitleDeps,
  type TextTitleFailure,
  type TextTitleProposal,
  type TextTitleResult,
  type TextTitleTool,
  type TitleKind,
  type TitleLimits,
  type TitleOutcome,
  type TitleResponseParse,
} from './titles.ts'

export {
  createDescribeImageTool,
  DESCRIBE_IMAGE_CONTRACT,
  DESCRIBE_IMAGE_RECIPE,
  DESCRIBE_IMAGE_RECIPE_JSON,
  DESCRIBE_IMAGE_TOOL,
  type DescribeImageDeps,
  type DescribeImageFailure,
  type DescribeImageResult,
  type DescribeImageTool,
  type ImageDescription,
} from './images.ts'

export {
  judgeRecipe,
  runRecipeCli,
  type RecipeCliIo,
  type RecipeVerdict,
} from './cli.ts'

export {
  DshLlmProvider,
  type DshCompletionRequest,
  type DshContentPart,
  type DshFailure,
  type DshFinishReason,
  type DshImagePart,
  type DshImageTransport,
  type DshLlmSurface,
  type DshModelDescriptor,
  type DshProviderOptions,
  type DshStreamChunk,
  type DshTextPart,
  type DshUserMessage,
} from './dsh-adapter.ts'
