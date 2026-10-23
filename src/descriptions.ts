/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */

/** One-line purpose of each tool built from a pinned native operation. */
export const OPERATION_SUMMARIES: Record<string, string> = {
  openai_ads_create_campaign: "Create a paused campaign with its objective, budget, schedule and targeting.",
  openai_ads_update_campaign: "Update campaign settings such as name, budget, schedule or targeting.",
  openai_ads_pause_campaign: "Pause a campaign and stop its delivery.",
  openai_ads_activate_campaign: "Activate a campaign. Activation can start delivery and spend budget.",
  openai_ads_archive_campaign: "Archive a campaign.",
  openai_ads_create_ad_group: "Create a paused ad group with its bidding, context hints and product set.",
  openai_ads_update_ad_group: "Update ad group settings such as name, bidding, context hints or product set.",
  openai_ads_pause_ad_group: "Pause an ad group and stop its delivery.",
  openai_ads_activate_ad_group: "Activate an ad group. Activation can start delivery and spend budget.",
  openai_ads_archive_ad_group: "Archive an ad group.",
  openai_ads_create_ad: "Create a paused ad with a chat card or product template creative. Creating an ad submits its creative for review.",
  openai_ads_update_ad: "Update an ad's name or creative. A creative edit starts a new review.",
  openai_ads_pause_ad: "Pause an ad and stop its delivery.",
  openai_ads_activate_ad: "Activate an ad. Activation can start delivery and spend budget.",
  openai_ads_archive_ad: "Archive an ad.",
  openai_ads_create_ad_preview: "Create a temporary preview of an existing ad. A preview shows appearance and does not confirm serving eligibility.",
  openai_ads_search_locations: "Search country, region and market location IDs for campaign geographic targeting.",
  openai_ads_get_audit_logs: "List recorded changes to the account's campaigns, ad groups and ads, optionally filtered by entity, actor or time.",
  openai_ads_get_spend_limits: "Read the account's spend limit windows and daily recurrence rules.",
  openai_ads_get_landing_page_crawl: "Read the saved landing page crawl evidence for an ad's submitted version.",
  openai_ads_get_conversion_settings: "List the account's conversion event settings, the goals a campaign can use.",
  openai_ads_get_conversion_pixels: "List the account's conversion pixels and connected pixel IDs.",
  openai_ads_get_conversion_events: "List recent sampled conversion events, for checking that a pixel or server integration sends data.",
  openai_ads_get_conversion_insights: "Read attributed conversion totals or daily values, optionally by country or device and with event details.",
  openai_ads_create_conversion_setting: "Create a conversion event setting for a standard or custom event.",
  openai_ads_create_conversion_pixel: "Create a conversion pixel.",
  openai_ads_get_feeds: "List the account's product feeds, optionally with product counts.",
  openai_ads_create_feed: "Create a product feed.",
  openai_ads_get_feed_uploads: "List recent product feed uploads and their processing results.",
  openai_ads_get_feed_settings: "Read a feed's display and organic-listing settings.",
  openai_ads_update_feed_settings: "Update a feed's display name and organic-listing settings.",
  openai_ads_get_feed_products: "List products in a feed that match ad group product filters.",
  openai_ads_update_feed_products: "Update the title, price or availability of existing product variants in a feed.",
  openai_ads_archive_feed: "Archive a product feed.",
  openai_ads_get_custom_audiences: "List the account's custom audiences.",
  openai_ads_get_custom_audience: "Read one custom audience and its matched count.",
  openai_ads_get_audience_operations: "List the accepted operations of a custom audience.",
  openai_ads_get_audience_operation: "Read the lifecycle state of one custom audience operation.",
};

/** Descriptions shared by equivalent parameters. A description set on the schema always wins. */
export const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  adAccountId: "The adacct_ ID configured in OPENAI_ADS_ACCOUNT_ID. The API key is scoped to this one account.",
  limit: "Maximum number of returned items or rows. The declared bounds and default apply; follow pagination for more.",
  after: "Next-page cursor: the previous page's last_id, used only when has_more is true.",
  before: "Previous-page cursor: the first_id of the page after the one you want.",
  order: "Sort order of the list by creation time.",
  name: "Return only entities whose name matches this text.",
  include: "Optional native expansions. serving_issues explains why an entity cannot serve.",
  since: "First day of the report, YYYY-MM-DD, in the account's time zone. Inclusive.",
  until: "Last day of the report, YYYY-MM-DD, in the account's time zone. Inclusive.",
};
