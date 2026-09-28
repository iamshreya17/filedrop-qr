from django.urls import include, path

# No upload, download, media, or history routes: the server only signals peers.
urlpatterns = [path('api/', include('sharer.urls'))]
