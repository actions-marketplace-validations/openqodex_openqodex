# Django: a deleted view keeps its route

Guards against a deleted view taking its route with it: the change deletes `post_detail` while `blog/urls.py` still registers it. The registration stays, its handler status is `missing`, a gap names the missing view, the brief says the route has no handler now, and the change's risk is high.
