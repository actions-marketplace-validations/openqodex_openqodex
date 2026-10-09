// The Rails plugin on a small real application and on hostile input.
import { getChange } from "@openqodex/core";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, detectImpact, frameworkLayer, openStore, renderImpactBlock } from "../src/index.js";
import type { Graph, Registration } from "../src/index.js";
import { rails } from "../src/frameworks/rails/index.js";
import { parserFor } from "../src/parser.js";
import { commitAll, git, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

const MiB = 1024 * 1024;
const home = makeHome();

// A small blog: routes with resources, a nested resource, a namespace and
// root; two posts controllers (the public one and the admin one) and a
// comments controller; a model with an association and the migrations that
// name its table; views and a partial; a job and a mailer with its view;
// config keys set in two files and read in an action; a request spec and
// a model spec.
const POSTS = `class PostsController < ApplicationController
  before_action :set_post, only: %i[show edit update destroy]

  def index
    render partial: "summary"
  end

  def show
    @size = Rails.application.config.x.page_size
  end

  def new
  end

  def create
    PublishJob.perform_later(1)
    PostMailer.published(1).deliver_later
  end

  def edit
    render :form
  end

  def update
  end

  def destroy
  end

  private

  def set_post
    @post = Post.find(params[:id])
  end
end
`;
const ADMIN_POSTS = `module Admin
  class PostsController < ApplicationController
    def index
    end

    def destroy
    end
  end
end
`;
const POST_MODEL = `class Post < ApplicationRecord
  has_many :comments

  def excerpt
    "x"
  end
end
`;
const APP: Record<string, string> = {
  Gemfile: 'source "https://rubygems.org"\n\ngem "rails", "~> 7.1"\ngem "rspec-rails", group: :test\n',
  "config/application.rb": 'module Blog\n  class Application < Rails::Application\n    config.x.page_size = 20\n    config.x.api_token = "s3cr3t-value"\n  end\nend\n',
  "config/environments/production.rb": "Rails.application.configure do\n  config.x.page_size = 50\nend\n",
  "config/routes.rb": `Rails.application.routes.draw do
  root "posts#index"
  resources :posts do
    resources :comments, only: [:create]
  end
  namespace :admin do
    resources :posts, only: [:index, :destroy]
  end
end
`,
  "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
  "app/controllers/posts_controller.rb": POSTS,
  "app/controllers/comments_controller.rb": "class CommentsController < ApplicationController\n  def create\n  end\nend\n",
  "app/controllers/admin/posts_controller.rb": ADMIN_POSTS,
  "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  primary_abstract_class\nend\n",
  "app/models/post.rb": POST_MODEL,
  "app/models/comment.rb": "class Comment < ApplicationRecord\n  belongs_to :post\nend\n",
  "db/migrate/20240101000000_create_posts.rb": "class CreatePosts < ActiveRecord::Migration[7.1]\n  def change\n    create_table :posts do |t|\n      t.string :title\n    end\n  end\nend\n",
  "db/migrate/20240102000000_add_slug_to_posts.rb": "class AddSlugToPosts < ActiveRecord::Migration[7.1]\n  def change\n    add_column :posts, :slug, :string\n  end\nend\n",
  "db/migrate/20240103000000_create_comments.rb": "class CreateComments < ActiveRecord::Migration[7.1]\n  def change\n    create_table :comments do |t|\n      t.references :post\n    end\n  end\nend\n",
  "app/views/posts/index.html.erb": "<h1>Posts</h1>\n",
  "app/views/posts/_summary.html.erb": "<p>Summary</p>\n",
  "app/views/posts/show.html.erb": "<h1>Post</h1>\n",
  "app/views/posts/form.html.erb": "<form></form>\n",
  "app/views/admin/posts/index.html.erb": "<h1>Admin</h1>\n",
  "app/jobs/application_job.rb": "class ApplicationJob < ActiveJob::Base\nend\n",
  "app/jobs/publish_job.rb": "class PublishJob < ApplicationJob\n  def perform(id)\n    @id = id\n  end\nend\n",
  "app/mailers/application_mailer.rb": "class ApplicationMailer < ActionMailer::Base\nend\n",
  "app/mailers/post_mailer.rb": "class PostMailer < ApplicationMailer\n  def published(id)\n    mail(to: id)\n  end\nend\n",
  "app/views/post_mailer/published.html.erb": "<p>Published</p>\n",
  "spec/requests/posts_spec.rb": 'require "rails_helper"\n\nRSpec.describe "Posts", type: :request do\n  it "shows a post" do\n    get "/posts/1"\n  end\n\n  it "deletes a post as an admin" do\n    delete "/admin/posts/1"\n  end\nend\n',
  "spec/models/post_spec.rb": 'require "rails_helper"\n\nRSpec.describe Post do\n  it "has an excerpt" do\n    Post.new.excerpt\n  end\nend\n',
};

const SHOW = "app/controllers/posts_controller.rb";
const ADMIN = "app/controllers/admin/posts_controller.rb";

async function storeOf(root: string) {
  const opened = await openStore(root, { home });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

// The application with `edits` written over it and left uncommitted: the
// graph, the impact and the brief of that change.
async function changed(edits: Record<string, string>, files: Record<string, string> = APP) {
  const root = makeRepo(files);
  commitAll(root);
  writeFiles(root, edits);
  const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
  const impact = detectImpact(graph, change);
  return { graph, impact, brief: renderImpactBlock(impact) };
}

async function built(files: Record<string, string> = APP): Promise<Graph> {
  const root = makeRepo(files);
  commitAll(root);
  return buildGraph({ repoRoot: root, store: null });
}

const registrations = (g: Graph) => g.frameworks?.entities.filter((e): e is Registration => e.kind === "registration" && e.plugin === "rails") ?? [];
const registration = (g: Graph, methods: string, pattern: string) => registrations(g).find((r) => r.methods.join("|") === methods && r.pattern === pattern);

function layerOf(g: Graph) {
  const layer = frameworkLayer(g);
  if (!layer) throw new Error("no framework layer");
  return layer;
}

// The names an edge kind leads to from a symbol or file: an entity's name, else the symbol id without its position.
function targets(g: Graph, from: string, kind: string): string[] {
  const layer = layerOf(g);
  return layer
    .edgesFrom(from)
    .filter((e) => e.kind === kind)
    .map((e) => {
      const x = layer.entity(e.to);
      if (!x) return e.to.replace(/@.*/, "");
      return x.kind === "registration" ? `${x.methods.join("|")} ${x.pattern}` : x.name;
    })
    .sort();
}

describe("the Rails plugin on a small application", () => {
  it("lists the route that handles a changed action, the view it renders and the request spec that requests it, and never calls a test link coverage", async () => {
    const { graph, brief } = await changed({ [SHOW]: POSTS.replace("@size = Rails.application.config.x.page_size", "@size = Rails.application.config.x.page_size + 1") });
    const show = symbol(graph, SHOW, "show", "PostsController");
    const routes = layerOf(graph).routesReaching(show).routes.map((r) => [r.registration.methods.join("|"), r.registration.pattern, r.registration.name, r.hops, r.tier]);
    expect(routes).toEqual([["GET", "/posts/:id", "post", 0, "likely"]]);
    expect(brief).toContain("| `GET /posts/:id` | `post` | `config/routes.rb:3` | `posts#show` | handles `PostsController.show` (likely: found by the controller path convention");
    expect(brief).toContain("| `PostsController.show` | `app/views/posts/show.html.erb` | likely: Rails renders app/views/posts/show when the action does not render another template |");
    expect(brief).toContain("| `posts_spec.rb` | `spec/requests/posts_spec.rb:5` | requests through route `GET /posts/:id` | `PostsController.show` | likely: the test requests a literal path that matches this route");
    expect(brief).toContain("(static links, not coverage)");
    expect(brief).not.toMatch(/\bcover(s|age:)/);
  });

  it("expands every resources route from the declaration, binds each to its action, and keeps the public and admin controllers apart", async () => {
    const g = await built();
    const handler = (methods: string, pattern: string) => {
      const r = registration(g, methods, pattern);
      return r ? [r.name, r.handler.written, r.handler.status, r.handler.targets.map((t) => t.replace(/@.*/, ""))] : null;
    };
    expect(handler("GET", "/")).toEqual(["root", "posts#index", "bound", [`${SHOW}#PostsController.index`]]);
    expect(handler("GET", "/posts")).toEqual(["posts", "posts#index", "bound", [`${SHOW}#PostsController.index`]]);
    expect(handler("GET", "/posts/new")).toEqual(["new_post", "posts#new", "bound", [`${SHOW}#PostsController.new`]]);
    expect(handler("PATCH|PUT", "/posts/:id")).toEqual(["post", "posts#update", "bound", [`${SHOW}#PostsController.update`]]);
    expect(handler("POST", "/posts/:post_id/comments")).toEqual(["post_comments", "comments#create", "bound", ["app/controllers/comments_controller.rb#CommentsController.create"]]);
    expect(handler("DELETE", "/admin/posts/:id")).toEqual(["admin_post", "admin/posts#destroy", "bound", [`${ADMIN}#Admin::PostsController.destroy`]]);
    // Seven, one and two routes from the three resources declarations, plus root.
    expect(registrations(g).length).toBe(11);
    expect(registration(g, "GET", "/admin/posts/:id")).toBeUndefined();
    expect(targets(g, symbol(g, SHOW, "PostsController"), "applies_middleware")).toEqual([`${SHOW}#PostsController.set_post`]);
    expect(layerOf(g).rolesOf(symbol(g, SHOW, "show", "PostsController")).map((r) => [r.role, r.detail])).toEqual([["route_handler", "action"]]);
    expect(layerOf(g).rolesOf("config/routes.rb").map((r) => r.role)).toEqual(["route_table"]);
  });

  it("keeps the route of a deleted action, with no handler, a gap that names it and a brief line that says so", async () => {
    const { graph, brief } = await changed({ [ADMIN]: ADMIN_POSTS.replace("\n    def destroy\n    end\n", "\n") });
    const r = registration(graph, "DELETE", "/admin/posts/:id");
    expect([r?.name, r?.handler.status, r?.handler.written]).toEqual(["admin_post", "missing", "admin/posts#destroy"]);
    expect(layerOf(graph).edgesFrom(r?.id ?? "").filter((e) => e.kind === "handles")).toEqual([]);
    const gaps = graph.frameworks?.unknowns.filter((u) => u.plugin === "rails" && u.name === "admin/posts#destroy").map((u) => [u.cause, u.site?.file, u.site?.line, u.scope]);
    expect(gaps).toEqual([["miss", "config/routes.rb", 7, { file: ADMIN }]]);
    // The public controller's destroy is a different action and stays bound.
    expect(registration(graph, "DELETE", "/posts/:id")?.handler.status).toBe("bound");
    expect(brief).toContain("| `DELETE /admin/posts/:id` | `admin_post` | `config/routes.rb:7` | `admin/posts#destroy` | no handler now: the handler is missing |");
  });

  it("links actions to their implicit views, explicit views and partials, and a changed partial back to the action that renders it", async () => {
    const { graph, brief } = await changed({ "app/views/posts/_summary.html.erb": "<p>Summary, changed</p>\n" });
    const action = (name: string) => symbol(graph, SHOW, name, "PostsController");
    expect(targets(graph, action("index"), "renders")).toEqual(["app/views/posts/_summary.html.erb", "app/views/posts/index.html.erb"]);
    expect(targets(graph, action("show"), "renders")).toEqual(["app/views/posts/show.html.erb"]);
    expect(targets(graph, action("edit"), "renders")).toEqual(["app/views/posts/form.html.erb"]);
    expect(targets(graph, action("new"), "renders")).toEqual([]);
    expect(targets(graph, symbol(graph, ADMIN, "index", "Admin::PostsController"), "renders")).toEqual(["app/views/admin/posts/index.html.erb"]);
    expect(brief).toContain("| `app/views/posts/_summary.html.erb` | `PostsController.index` | `app/controllers/posts_controller.rb:5` |");
  });

  it("links the model to its association, its table and the migrations that name the table, for a model change and a migration change", async () => {
    const { graph, brief } = await changed({
      "app/models/post.rb": POST_MODEL.replace("  has_many :comments\n", "  has_many :comments\n  validates :title, presence: true\n"),
      "db/migrate/20240102000000_add_slug_to_posts.rb": (APP["db/migrate/20240102000000_add_slug_to_posts.rb"] as string).replace(":slug, :string", ":slug, :text"),
    });
    const post = symbol(graph, "app/models/post.rb", "Post");
    expect(layerOf(graph).rolesOf(post).map((r) => r.role)).toEqual(["model"]);
    expect(targets(graph, post, "uses_type")).toEqual(["app/models/comment.rb#Comment"]);
    expect(targets(graph, post, "maps_to")).toEqual(["posts"]);
    expect(layerOf(graph).edgesTo(post).filter((e) => e.kind === "changes_schema").map((e) => e.from).sort()).toEqual(["db/migrate/20240101000000_create_posts.rb", "db/migrate/20240102000000_add_slug_to_posts.rb"]);
    expect(targets(graph, "db/migrate/20240103000000_create_comments.rb", "changes_schema")).toEqual(["app/models/comment.rb#Comment", "comments"]);
    expect(layerOf(graph).rolesOf(symbol(graph, "app/models/application_record.rb", "ApplicationRecord"))).toEqual([]);
    expect(brief).toContain("| `Post` | `db/migrate/20240101000000_create_posts.rb` (`create_table posts`), `db/migrate/20240102000000_add_slug_to_posts.rb` (`add_column posts.slug`) |");
    expect(brief).toContain("| `db/migrate/20240102000000_add_slug_to_posts.rb` | `posts`, `Post` |");
  });

  it("links the enqueue and delivery sites to the job's perform method and the mailer method, and the mailer method to its view", async () => {
    const g = await built();
    const create = symbol(g, SHOW, "create", "PostsController");
    expect(targets(g, create, "enqueues")).toEqual(["app/jobs/publish_job.rb#PublishJob.perform", "app/mailers/post_mailer.rb#PostMailer.published"]);
    expect(targets(g, symbol(g, "app/mailers/post_mailer.rb", "published", "PostMailer"), "renders")).toEqual(["app/views/post_mailer/published.html.erb"]);
    expect(layerOf(g).rolesOf(symbol(g, "app/jobs/publish_job.rb", "PublishJob")).map((r) => [r.role, r.detail])).toEqual([["job", "active_job"]]);
    expect(layerOf(g).rolesOf(symbol(g, "app/jobs/application_job.rb", "ApplicationJob"))).toEqual([]);
    expect(layerOf(g).rolesOf(symbol(g, "app/mailers/post_mailer.rb", "PostMailer")).map((r) => r.role)).toEqual(["mailer"]);
  });

  it("links config keys to the files that set them and the action that reads them, by name and never by value", async () => {
    const g = await built();
    expect(targets(g, "config/application.rb", "defines_config")).toEqual(["config.x.api_token", "config.x.page_size"]);
    expect(targets(g, "config/environments/production.rb", "defines_config")).toEqual(["config.x.page_size"]);
    expect(targets(g, symbol(g, SHOW, "show", "PostsController"), "reads_config")).toEqual(["config.x.page_size"]);
    expect(JSON.stringify(g.frameworks)).not.toContain("s3cr3t-value");
  });

  it("links the request spec to the routes it requests and the model spec to the model it names and the method it calls, as static links", async () => {
    const g = await built();
    const tests = (file: string) =>
      layerOf(g)
        .edgesFrom(file)
        .filter((e) => e.kind === "tests")
        .map((e) => {
          const x = layerOf(g).entity(e.to);
          return [x && x.kind === "registration" ? `${x.methods.join("|")} ${x.pattern}` : e.to.replace(/@.*/, ""), e.category, e.evidence.tier];
        })
        .sort((a, b) => a.join(" ").localeCompare(b.join(" ")));
    expect(tests("spec/requests/posts_spec.rb")).toEqual([
      ["DELETE /admin/posts/:id", "route-request", "likely"],
      ["GET /posts/:id", "route-request", "likely"],
    ]);
    // `Post.new.excerpt` calls the class and the method; the language graph
    // finds Post by the autoload convention, so both calls are likely.
    expect(tests("spec/models/post_spec.rb")).toEqual([
      ["app/models/post.rb#Post", "direct-call", "likely"],
      ["app/models/post.rb#Post", "subject", "possible"],
      ["app/models/post.rb#Post.excerpt", "direct-call", "likely"],
    ]);
    expect(layerOf(g).rolesOf("spec/requests/posts_spec.rb").map((r) => r.role)).toEqual(["test"]);
  });

  it("keeps the known part of a route whose prefix is computed for display, and never matches it as a pattern", async () => {
    const g = await built({
      ...APP,
      "config/routes.rb": 'Rails.application.routes.draw do\n  scope ENV["PREFIX"] do\n    get "/posts", to: "posts#index"\n    resources :comments, only: :create\n  end\nend\n',
    });
    const shown = registrations(g).map((r) => [r.methods.join("|"), r.pattern, r.partial ?? null]);
    expect(shown).toEqual([
      ["GET", null, "/{computed}/posts"],
      ["POST", null, "/{computed}/comments"],
    ]);
    expect(registrations(g)[0]?.handler.status).toBe("bound");
  });

  it("finds the routes of unchanged files once rails is added to the Gemfile, from cached facts, never from a stale build", async () => {
    const root = makeRepo({ ...APP, Gemfile: 'source "https://rubygems.org"\n\ngem "sinatra"\n' });
    commitAll(root);
    const store = await storeOf(root);
    const before = await buildGraph({ repoRoot: root, store });
    expect(before.frameworks?.apps.filter((a) => a.plugin === "rails")).toEqual([]);
    expect(registrations(before)).toEqual([]);
    writeFiles(root, { Gemfile: APP.Gemfile as string });
    git(root, "add", "-A");
    const after = await buildGraph({ repoRoot: root, store });
    // Every Ruby file's facts come from the cache: nothing was parsed again.
    expect(after.status.parses).toBe(0);
    expect(after.frameworks?.apps.filter((a) => a.plugin === "rails").length).toBe(1);
    expect(registration(after, "GET", "/posts/:id")?.handler.status).toBe("bound");
  });

  it("keeps the framework data in a retained index equal to the fresh build, and never reuses it once a view it names is added", async () => {
    const root = makeRepo(APP);
    commitAll(root);
    const store = await storeOf(root);
    const fresh = await buildGraph({ repoRoot: root, store, mode: "retained" });
    const loaded = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(loaded.status.parses).toBe(0);
    expect(loaded.status.generation).toBe(fresh.status.generation);
    expect(JSON.stringify(loaded.frameworks)).toBe(JSON.stringify(fresh.frameworks));
    expect(targets(loaded, symbol(loaded, SHOW, "new", "PostsController"), "renders")).toEqual([]);
    // A view is not a source file: only the plugin's inputs name it.
    writeFiles(root, { "app/views/posts/new.html.erb": "<h1>New</h1>\n" });
    git(root, "add", "-A");
    const next = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(next.frameworks?.fingerprint).not.toBe(fresh.frameworks?.fingerprint);
    expect(targets(next, symbol(next, SHOW, "new", "PostsController"), "renders")).toEqual(["app/views/posts/new.html.erb"]);
  });
});

// Repeats `unit` until the text is just under `bytes`.
function fill(head: string, unit: (i: number) => string, tail: string, bytes: number): string {
  const parts = [head];
  let size = Buffer.byteLength(head) + Buffer.byteLength(tail);
  for (let i = 0; ; i++) {
    const u = unit(i);
    const n = Buffer.byteLength(u);
    if (size + n >= bytes) break;
    parts.push(u);
    size += n;
  }
  parts.push(tail);
  return parts.join("");
}

describe("the Rails plugin on hostile input", () => {
  // Resources that multiply past the registration cap, route blocks nested
  // past the depth cap, patterns with many slots, optional groups and globs,
  // and test requests built to make a pattern matcher backtrack: a routes
  // file and a spec file just under 1 MiB each.
  const deep = `resources :n do ${"resources :m do ".repeat(10)}${"end ".repeat(10)}end`;
  const routes = fill(
    "Rails.application.routes.draw do\n",
    (i) =>
      i % 4 === 0
        ? `  resources :r${i}\n`
        : i % 4 === 1
          ? `  get "/a${"/:p".repeat(40)}/x${i}", to: "x#y"\n`
          : i % 4 === 2
            ? `  get "/a${"(/:o)".repeat(6)}/*g/*h/x${i}", to: "x#y"\n`
            : `  ${deep}\n`,
    "end\n",
    MiB - 1024,
  );
  const spec = fill(
    'RSpec.describe "Hostile", type: :request do\n  it "requests" do\n',
    (i) => (i % 2 === 0 ? `    get "/${"a/".repeat(254)}!"\n` : `    get "/a/${"(".repeat(100)}${"a".repeat(300)}"\n    get r${i}_path\n`),
    "  end\nend\n",
    MiB - 1024,
  );
  const files: Record<string, string> = {
    Gemfile: 'source "https://rubygems.org"\n\ngem "rails"\ngem "rspec-rails"\n',
    "config/routes.rb": routes,
    "app/controllers/x_controller.rb": "class XController < ActionController::Base\n  def y\n  end\nend\n",
    "spec/requests/hostile_spec.rb": spec,
  };

  it("reads the facts of a 1 MiB hostile routes file and spec file in under a second each", async () => {
    const parser = await parserFor("ruby");
    for (const source of [routes, spec]) {
      const tree = parser.parse(source);
      if (!tree) throw new Error("no tree");
      const started = performance.now();
      rails.facts(tree.rootNode, "ruby");
      const ms = performance.now() - started;
      tree.delete();
      expect(ms).toBeLessThan(1000);
    }
    parser.delete();
  }, 60_000);

  it("resolves hostile resources, deep nesting, slot-heavy patterns and backtracking requests in under a second, with every cap named as a gap", async () => {
    const root = makeRepo(files);
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * MiB, budgetMs: 120_000 });
    const data = graph.frameworks;
    expect(data?.plugins.find((p) => p.id === "rails")?.status).toBe("ok");
    expect(graph.status.stages.frameworks ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
    const capped = data?.unknowns.filter((u) => u.plugin === "rails" && (u.cause === "fan-out-capped" || u.cause === "budget")) ?? [];
    expect(capped.length).toBeGreaterThan(0);
    expect(registrations(graph).length).toBeLessThanOrEqual(10_000);
  }, 120_000);
});
